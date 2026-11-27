import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { isError } from "ethers";
import type { TransactionRequest } from "ethers";
import type { ExpiringTimelockController, TimelockController } from "../typechain-types";
import { revertedWithoutData } from "../scripts/lib/gracePeriod";
import { advanceTimelock, GovernanceTimelock, TimelockStepRequest } from "../scripts/lib/timelockStep";
import {
  EMPTY_REVERT_EMPTY_DATA,
  EMPTY_REVERT_NO_DATA,
  ethersCallError,
  HEADER_NOT_FOUND,
  RATE_LIMITED,
} from "./helpers/rpcErrors";

type HardhatEthersSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

const GRACE_PERIOD_SELECTOR = ethers.id("GRACE_PERIOD()").slice(0, 10);

/**
 * A signer whose GRACE_PERIOD() reads fail with `failure` and whose every other call and
 * transaction goes through untouched: an RPC that drops or refuses one request.
 */
function failingGracePeriod(signer: HardhatEthersSigner, failure: Error): HardhatEthersSigner {
  return new Proxy(signer, {
    get(target, prop) {
      if (prop === "call") {
        return async (tx: TransactionRequest): Promise<string> => {
          if (typeof tx.data === "string" && tx.data.startsWith(GRACE_PERIOD_SELECTOR)) throw failure;
          return target.call(tx);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * scripts/lib/timelockStep.ts tells a timelock without a grace period (a stock
 * TimelockController, deployed before 2026-11-06) from one whose GRACE_PERIOD() read failed.
 * Only a call that reverted with no data means the function is missing; anything else, a
 * dropped request above all, stops the step instead of executing as if no grace period applied.
 */
describe("Timelock step: telling a missing grace period from a failed read", function () {
  const MIN_DELAY = 48 * 3600;
  let proposer: HardhatEthersSigner;
  let executor: HardhatEthersSigner;

  async function deploy(kind: "TimelockController" | "ExpiringTimelockController"): Promise<GovernanceTimelock> {
    [, proposer, executor] = await ethers.getSigners();
    const factory = await ethers.getContractFactory(kind);
    const timelock = await factory.deploy(MIN_DELAY, [proposer.address], [executor.address], ethers.ZeroAddress);
    return timelock as unknown as TimelockController | ExpiringTimelockController;
  }

  /** The timelock raising its own delay by a second: an operation with no other contract involved. */
  async function request(timelock: GovernanceTimelock, signer: HardhatEthersSigner, lines: string[]): Promise<TimelockStepRequest> {
    return {
      timelock,
      signer,
      target: await timelock.getAddress(),
      data: timelock.interface.encodeFunctionData("updateDelay", [MIN_DELAY + 1]),
      salt: ethers.id("timelock step test"),
      label: "updateDelay",
      confirm: true,
      guard: async () => undefined,
      log: (line) => lines.push(line),
    };
  }

  it("executes on a timelock that predates 2026-11-06 (GRACE_PERIOD reverts with no data)", async function () {
    const timelock = await deploy("TimelockController");
    const lines: string[] = [];
    expect((await advanceTimelock(await request(timelock, proposer, lines))).step).to.equal("scheduled");
    await time.increase(MIN_DELAY + 1);
    const outcome = await advanceTimelock(await request(timelock, executor, lines));
    expect(outcome.step).to.equal("executed");
    expect(outcome.expiresAt).to.equal(undefined);
    expect(lines.join("\n")).to.include("predates 2026-11-06");
    expect(await timelock.getMinDelay()).to.equal(BigInt(MIN_DELAY + 1));
  });

  it("rethrows a network error on GRACE_PERIOD() and sends nothing", async function () {
    const timelock = await deploy("ExpiringTimelockController");
    const lines: string[] = [];
    const first = await advanceTimelock(await request(timelock, proposer, lines));
    expect(first.step).to.equal("scheduled");
    const dropped = ethers.makeError("the gateway dropped the request", "NETWORK_ERROR", { event: "test" });

    // Waiting: the report needs the grace period too.
    await expect(advanceTimelock(await request(timelock, failingGracePeriod(executor, dropped), lines))).to.be.rejectedWith(
      "the gateway dropped the request"
    );

    // Ready: without the fix this executed as if the timelock had no grace period.
    await time.increase(MIN_DELAY + 1);
    await expect(advanceTimelock(await request(timelock, failingGracePeriod(executor, dropped), lines))).to.be.rejectedWith(
      "the gateway dropped the request"
    );
    expect(lines.join("\n")).to.not.include("predates 2026-11-06");
    expect(await timelock.getMinDelay()).to.equal(BigInt(MIN_DELAY), "nothing executed");
    expect(await timelock.isOperationReady(first.operationId)).to.equal(true);

    // The same run on a healthy connection executes inside the grace period.
    const outcome = await advanceTimelock(await request(timelock, executor, lines));
    expect(outcome.step).to.equal("executed");
    expect(outcome.expiresAt).to.be.a("number");
  });

  it("rethrows a revert that carries data: only an empty revert means the function is missing", async function () {
    const timelock = await deploy("ExpiringTimelockController");
    const lines: string[] = [];
    await advanceTimelock(await request(timelock, proposer, lines));
    await time.increase(MIN_DELAY + 1);
    const withData = Object.assign(new Error("execution reverted: something else"), {
      code: "CALL_EXCEPTION",
      data: ethers.id("SomethingElse()").slice(0, 10),
    });
    // ethers decodes the data it was given into its own CALL_EXCEPTION, which still carries it.
    await expect(advanceTimelock(await request(timelock, failingGracePeriod(executor, withData), lines))).to.be.rejectedWith(
      /execution reverted/
    );
    expect(await timelock.getMinDelay()).to.equal(BigInt(MIN_DELAY), "nothing executed");
  });

  // Through a JSON-RPC endpoint ethers turns every error body an eth_call returns into a
  // CALL_EXCEPTION with data null, so a rate limit or a lagging node looked exactly like an empty
  // revert and the step executed as if the timelock had no grace period.
  it("rethrows a rate limit or a missing header, which ethers reports as a CALL_EXCEPTION with no data", async function () {
    const transient = [ethersCallError(GRACE_PERIOD_SELECTOR, RATE_LIMITED), ethersCallError(GRACE_PERIOD_SELECTOR, HEADER_NOT_FOUND)];
    for (const failure of transient) {
      expect(isError(failure, "CALL_EXCEPTION") && failure.data === null, "the shape an empty revert has too").to.equal(true);
      expect(revertedWithoutData(failure)).to.equal(false);
    }

    const timelock = await deploy("ExpiringTimelockController");
    const lines: string[] = [];
    const first = await advanceTimelock(await request(timelock, proposer, lines));
    await time.increase(MIN_DELAY + 1);
    for (const failure of transient) {
      await expect(advanceTimelock(await request(timelock, failingGracePeriod(executor, failure), lines))).to.be.rejectedWith(
        /missing revert data/
      );
    }
    expect(lines.join("\n")).to.not.include("predates 2026-11-06");
    expect(await timelock.getMinDelay()).to.equal(BigInt(MIN_DELAY), "nothing executed");
    expect(await timelock.isOperationReady(first.operationId)).to.equal(true);
  });

  it("still reads a node's empty revert as a missing GRACE_PERIOD(), with or without a data field", async function () {
    for (const body of [EMPTY_REVERT_NO_DATA, EMPTY_REVERT_EMPTY_DATA]) {
      const emptyRevert = ethersCallError(GRACE_PERIOD_SELECTOR, body);
      expect(revertedWithoutData(emptyRevert)).to.equal(true);

      const timelock = await deploy("TimelockController");
      const lines: string[] = [];
      await advanceTimelock(await request(timelock, proposer, lines));
      await time.increase(MIN_DELAY + 1);
      const outcome = await advanceTimelock(await request(timelock, failingGracePeriod(executor, emptyRevert), lines));
      expect(outcome.step).to.equal("executed");
      expect(outcome.expiresAt).to.equal(undefined);
      expect(lines.join("\n")).to.include("predates 2026-11-06");
    }
  });
});
