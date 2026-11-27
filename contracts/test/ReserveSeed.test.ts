import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { GoldStabilityReserve, MockAggregatorV3, MockERC20 } from "../typechain-types";
import {
  DIRECT_TRANSFER_WARNING,
  assertSeedable,
  encodeApprove,
  encodeSeed,
  parseSeedAmount,
  readHolder,
  readSeedContext,
  resolveSeedToken,
} from "../scripts/lib/reserveSeed";

type HardhatEthersSigner = Awaited<ReturnType<typeof ethers.getSigners>>[number];

/**
 * The reserve seed calldata (scripts/print-reserve-seed.ts), proven against the real reserve: a
 * holder that submits exactly these two transactions seeds it, and a plain transfer does not.
 */
describe("Reserve seed calldata (scripts/print-reserve-seed.ts)", function () {
  let holder: HardhatEthersSigner;
  let governanceRecipient: HardhatEthersSigner;
  let reserve: GoldStabilityReserve;
  let paxg: MockERC20;
  let xaut: MockERC20;

  beforeEach(async function () {
    [, holder, governanceRecipient] = await ethers.getSigners();
    paxg = await (await ethers.getContractFactory("MockERC20")).deploy("Paxos Gold", "PAXG", 18);
    xaut = await (await ethers.getContractFactory("MockERC20")).deploy("Tether Gold", "XAUt", 6);
    const feed = (await (await ethers.getContractFactory("MockAggregatorV3")).deploy(8)) as MockAggregatorV3;
    const now = await time.latest();
    await feed.setLatestRoundData(1, 4_150_00000000n, now, now, 1);
    const oracle = await (await ethers.getContractFactory("GoldOracle")).deploy(await feed.getAddress(), await feed.getAddress(), await paxg.getAddress(), await xaut.getAddress(), 90000);
    const stablecoin = await (await ethers.getContractFactory("GoldStablecoin")).deploy();
    reserve = (await (await ethers.getContractFactory("GoldStabilityReserve")).deploy(await stablecoin.getAddress(), await oracle.getAddress())) as GoldStabilityReserve;
    // The launch shape: PAXG a supported reserve asset, XAUT not configured at all.
    await reserve.setAssetConfig(await paxg.getAddress(), true, 0, 200_000);
    await paxg.mint(holder.address, ethers.parseUnits("100", 18));
    await xaut.mint(holder.address, ethers.parseUnits("100", 6));
  });

  async function seedOf(token: MockERC20, amount: bigint) {
    return { reserve: await reserve.getAddress(), token: await token.getAddress(), amount };
  }

  it("seeds the reserve when the holder sends exactly the two printed transactions", async function () {
    const context = await readSeedContext(ethers.provider, await reserve.getAddress(), await paxg.getAddress());
    expect(context).to.deep.equal({ symbol: "PAXG", decimals: 18, supported: true, collateralBalance: 0n });
    assertSeedable(await paxg.getAddress(), context);
    const amount = parseSeedAmount("25.5", context.decimals, context.symbol);
    const seed = await seedOf(paxg, amount);
    const approve = encodeApprove(seed, context);
    const pull = encodeSeed(seed, context);
    expect(approve.to).to.equal(await paxg.getAddress());
    expect(pull.to).to.equal(await reserve.getAddress());
    expect(approve.value).to.equal("0");
    expect(pull.value).to.equal("0");

    // The Safe is stood in for by a plain holder: the calldata is all that reaches the contracts.
    await holder.sendTransaction({ to: approve.to, data: approve.data });
    expect(await paxg.allowance(holder.address, await reserve.getAddress())).to.equal(amount);
    await expect(holder.sendTransaction({ to: pull.to, data: pull.data }))
      .to.emit(reserve, "CollateralSeeded")
      .withArgs(await paxg.getAddress(), holder.address, amount, amount);
    expect(await reserve.collateralBalance(await paxg.getAddress())).to.equal(amount);
    expect(await reserve.totalGoldSeeded(await paxg.getAddress())).to.equal(amount);
    expect(await paxg.balanceOf(holder.address)).to.equal(ethers.parseUnits("74.5", 18));
    // The approval was for the exact amount, so nothing is left for the reserve to pull later.
    expect(await paxg.allowance(holder.address, await reserve.getAddress())).to.equal(0n);
  });

  it("needs no role: seedCollateral is permissionless, so the sender is whoever holds the gold", async function () {
    const context = await readSeedContext(ethers.provider, await reserve.getAddress(), await paxg.getAddress());
    const seed = await seedOf(paxg, 10n ** 18n);
    for (const role of [await reserve.DEFAULT_ADMIN_ROLE(), await reserve.GOVERNANCE_ROLE(), await reserve.VAULT_ROLE()]) {
      expect(await reserve.hasRole(role, holder.address)).to.equal(false);
    }
    await holder.sendTransaction(encodeApprove(seed, context));
    await holder.sendTransaction(encodeSeed(seed, context));
    expect(await reserve.collateralBalance(seed.token)).to.equal(seed.amount);
  });

  it("the second transaction reverts without the first, so the order matters", async function () {
    const context = await readSeedContext(ethers.provider, await reserve.getAddress(), await paxg.getAddress());
    const pull = encodeSeed(await seedOf(paxg, 10n ** 18n), context);
    await expect(holder.sendTransaction({ to: pull.to, data: pull.data })).to.be.reverted;
  });

  it("refuses a token the reserve does not accept, before any calldata exists for it", async function () {
    const context = await readSeedContext(ethers.provider, await reserve.getAddress(), await xaut.getAddress());
    expect(context).to.include({ symbol: "XAUt", decimals: 6, supported: false });
    const token = await xaut.getAddress();
    expect(() => assertSeedable(token, context)).to.throw('seedCollateral would revert "Unsupported token"');
    // And the contract does refuse it: the printed call would have reverted in the Safe.
    const seed = await seedOf(xaut, 1_000_000n);
    await holder.sendTransaction(encodeApprove(seed, context));
    await expect(holder.sendTransaction(encodeSeed(seed, context))).to.be.revertedWith("Unsupported token");
  });

  it("a plain transfer to the reserve is not counted and governance cannot withdraw it", async function () {
    const amount = ethers.parseUnits("5", 18);
    await paxg.connect(holder).transfer(await reserve.getAddress(), amount);
    expect(await paxg.balanceOf(await reserve.getAddress())).to.equal(amount);
    expect(await reserve.collateralBalance(await paxg.getAddress())).to.equal(0n);
    expect(await reserve.redeemableCollateral(await paxg.getAddress())).to.equal(0n);
    // The deployer still governs the reserve here and still cannot take the stranded tokens out.
    await expect(reserve.withdrawCollateral(await paxg.getAddress(), governanceRecipient.address, amount)).to.be.revertedWith("Exceeds balance");
    expect(DIRECT_TRANSFER_WARNING.join(" ")).to.include("NEVER SEND THE TOKEN TO THE RESERVE WITH A PLAIN TRANSFER");
    expect(DIRECT_TRANSFER_WARNING.join(" ")).to.include("locked for good");
  });

  it("scales the amount by the decimals read from the token and refuses what the token cannot hold", function () {
    expect(parseSeedAmount("25", 18, "PAXG")).to.equal(25n * 10n ** 18n);
    expect(parseSeedAmount(" 0.5 ", 18, "PAXG")).to.equal(5n * 10n ** 17n);
    expect(parseSeedAmount("12.345678", 6, "XAUt")).to.equal(12_345_678n);
    expect(() => parseSeedAmount("12.3456789", 6, "XAUt")).to.throw("7 decimal places; XAUt has 6");
    expect(() => parseSeedAmount(undefined, 18, "PAXG")).to.throw("Set SEED_AMOUNT");
    expect(() => parseSeedAmount("", 18, "PAXG")).to.throw("Set SEED_AMOUNT");
    for (const bad of ["-1", "1e3", "ten", "1,5", "0x10", ".5"]) expect(() => parseSeedAmount(bad, 18, "PAXG"), bad).to.throw("plain decimal number");
    expect(() => parseSeedAmount("0", 18, "PAXG")).to.throw("above zero");
    expect(() => parseSeedAmount("0.000", 18, "PAXG")).to.throw("above zero");
  });

  it("resolves the token by name against the snapshot, or takes an address", async function () {
    const tokens = { paxgToken: await paxg.getAddress(), xautToken: await xaut.getAddress() };
    expect(resolveSeedToken(undefined, tokens)).to.equal(tokens.paxgToken);
    expect(resolveSeedToken("PAXG", tokens)).to.equal(tokens.paxgToken);
    expect(resolveSeedToken(" xaut ", tokens)).to.equal(tokens.xautToken);
    expect(resolveSeedToken(tokens.xautToken.toLowerCase(), tokens)).to.equal(tokens.xautToken);
    expect(() => resolveSeedToken("gold", tokens)).to.throw("SEED_TOKEN must be paxg, xaut or a token address");
  });

  it("writes the decoded line from the same values the calldata carries", async function () {
    const context = { symbol: "PAXG", decimals: 18 };
    const seed = await seedOf(paxg, ethers.parseUnits("25", 18));
    const approve = encodeApprove(seed, context);
    const pull = encodeSeed(seed, context);
    expect(approve.decoded).to.equal(`PAXG.approve(spender ${seed.reserve}, amount 25000000000000000000) = 25.0 PAXG`);
    expect(pull.decoded).to.equal(`GoldStabilityReserve.seedCollateral(token ${seed.token}, amount 25000000000000000000) = 25.0 PAXG`);
    expect(paxg.interface.decodeFunctionData("approve", approve.data)).to.deep.equal([seed.reserve, seed.amount]);
    expect(reserve.interface.decodeFunctionData("seedCollateral", pull.data)).to.deep.equal([seed.token, seed.amount]);
    expect(() => encodeSeed({ ...seed, amount: 0n }, context)).to.throw("above zero");
    expect(() => encodeApprove({ ...seed, reserve: ethers.ZeroAddress }, context)).to.throw("zero address");
    expect(() => encodeApprove({ ...seed, token: seed.reserve }, context)).to.throw("same address");
  });

  it("reads what the sending Safe holds and has approved, and refuses an address with no code as reserve or token", async function () {
    const seed = await seedOf(paxg, 10n ** 18n);
    expect(await readHolder(ethers.provider, seed, holder.address)).to.deep.equal({ balance: ethers.parseUnits("100", 18), allowance: 0n });
    await expect(readSeedContext(ethers.provider, holder.address, seed.token)).to.be.rejectedWith("has no code");
    await expect(readSeedContext(ethers.provider, seed.reserve, holder.address)).to.be.rejectedWith("has no code");
  });
});
