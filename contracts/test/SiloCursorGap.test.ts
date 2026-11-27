import { expect } from "chai";
import { ethers } from "hardhat";
import { SiloFactory, MockERC20 } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { siloGapChecks, type SiloGapCheck } from "../scripts/lib/siloGap";

/**
 * A deposit creates every clone missing up to the deposit cursor. Governance can move the
 * cursor forward by up to 64 a call, any number of times, and never back, so a long skipped
 * run leaves more creations for the next deposit than one transaction can carry (2^24 gas).
 * `createSilos` creates the same clones ahead of the deposit, in bounded batches, and is open
 * to anyone because it never creates a clone a deposit would not create.
 */
describe("SiloFactory: filling the gap behind a moved cursor", function () {
  this.timeout(300_000);

  /** The most gas one transaction may carry. */
  const TX_GAS_CAP = 16_777_216n;
  /** New state has been observed to cost about five times the local figure on a repriced network. */
  const REPRICING_FACTOR = 5n;

  let factory: SiloFactory;
  let token: MockERC20;
  let tokenAddress: string;
  let admin: HardhatEthersSigner;
  let vaultRole: HardhatEthersSigner;
  let anyone: HardhatEthersSigner;
  let batch: bigint;

  beforeEach(async function () {
    [admin, vaultRole, anyone] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockERC20")).deploy("Pax Gold", "PAXG", 18);
    tokenAddress = await token.getAddress();
    factory = await (await ethers.getContractFactory("SiloFactory")).deploy(ethers.parseEther("100"));
    await factory.grantRole(await factory.VAULT_ROLE(), vaultRole.address);
    await token.mint(vaultRole.address, ethers.parseEther("100000"));
    await token.connect(vaultRole).approve(await factory.getAddress(), ethers.MaxUint256);
    batch = await factory.MAX_CREATE_BATCH();
  });

  /** Move the cursor forward by `distance`, in governance steps of at most 64. */
  async function moveCursor(distance: bigint) {
    let cursor = await factory.currentSiloIndex(tokenAddress);
    const target = cursor + distance;
    while (cursor < target) {
      const step = target - cursor > 64n ? 64n : target - cursor;
      cursor += step;
      await factory.connect(admin).setCurrentSiloIndex(tokenAddress, cursor);
    }
  }

  async function gasOf(tx: Promise<{ wait: () => Promise<{ gasUsed: bigint } | null> }>) {
    const receipt = await (await tx).wait();
    if (receipt === null) throw new Error("no receipt");
    return receipt.gasUsed;
  }

  describe("the problem", function () {
    it("one deposit across a 200-silo gap needs more gas than a transaction may carry", async function () {
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10"));
      await moveCursor(200n);
      expect(await factory.missingSilos(tokenAddress)).to.equal(200n);

      // At the cap the deposit runs out of gas; it only completes with far more than a
      // transaction is allowed.
      await expect(
        factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10"), { gasLimit: TX_GAS_CAP })
      ).to.be.reverted;
      // 200 creations at the measured cost of one (about 110,000 gas) is some 22,000,000 gas.
      await factory.connect(anyone).createSilos(tokenAddress, 1n);
      const one = await gasOf(factory.connect(anyone).createSilos(tokenAddress, 1n));
      expect(one * 198n).to.be.gt(TX_GAS_CAP);
      await expect(
        factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10"), { gasLimit: TX_GAS_CAP })
      ).to.be.reverted;
      // The failed deposits created nothing.
      expect(await factory.getSiloCount(tokenAddress)).to.equal(3n);
    });
  });

  describe("createSilos", function () {
    it("walks a 200-silo gap in batches, after which a deposit is an ordinary deposit", async function () {
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10"));
      const ordinary = await gasOf(factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10")));
      await moveCursor(200n);

      let calls = 0;
      let worst = 0n;
      while ((await factory.missingSilos(tokenAddress)) > 0n) {
        const gas = await gasOf(factory.connect(anyone).createSilos(tokenAddress, batch));
        if (gas > worst) worst = gas;
        calls++;
      }
      expect(calls).to.equal(Math.ceil(200 / Number(batch)));
      expect(await factory.getSiloCount(tokenAddress)).to.equal(201n);
      // A full batch fits the cap with room to spare even if new state costs five times as much.
      expect(worst * REPRICING_FACTOR).to.be.lt((TX_GAS_CAP * 2n) / 3n);

      const afterFill = await gasOf(factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10")));
      // The deposit creates nothing: it costs what a deposit into an existing, empty silo costs.
      expect(afterFill).to.be.lt(ordinary + 60_000n);
      expect(await factory.getSiloCount(tokenAddress)).to.equal(201n);
      expect(await factory.currentSiloIndex(tokenAddress)).to.equal(200n);
      const silo = await factory.getSilo(tokenAddress, 200);
      expect(await token.balanceOf(silo)).to.equal(ethers.parseEther("10"));
      expect(await factory.totalCollateral(tokenAddress)).to.equal(ethers.parseEther("30"));
    });

    it("measures the gas of one clone and of a full batch", async function () {
      await moveCursor(64n);
      const one = await gasOf(factory.connect(anyone).createSilos(tokenAddress, 1n));
      const full = await gasOf(factory.connect(anyone).createSilos(tokenAddress, batch));
      const perClone = (full - one) / (batch - 1n);
      console.log(
        `        createSilos: ${one} gas for one clone, ${full} for ${batch}, about ${perClone} per further clone; ` +
          `a full batch at ${REPRICING_FACTOR}x is ${full * REPRICING_FACTOR} of ${TX_GAS_CAP}`
      );
      // Measured on Hardhat: about 115,000 gas a clone. The bounds catch a regression.
      expect(perClone).to.be.gt(90_000n).and.lt(130_000n);
      expect(full).to.be.lt(2_100_000n);
    });

    it("creates the clones a deposit would create: same addresses, same order, same events", async function () {
      await moveCursor(5n);
      const predicted: string[] = [];
      for (let i = 0; i < 6; i++) predicted.push(await factory.predictSiloAddress(tokenAddress, i));

      const tx = factory.connect(anyone).createSilos(tokenAddress, 4n);
      for (let i = 0; i < 4; i++) {
        await expect(tx).to.emit(factory, "SiloCreated").withArgs(tokenAddress, predicted[i], i);
      }
      expect(await factory.getSiloCount(tokenAddress)).to.equal(4n);
      expect(await factory.missingSilos(tokenAddress)).to.equal(2n);

      // The deposit creates the rest itself.
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10"));
      for (let i = 0; i < 6; i++) expect(await factory.getSilo(tokenAddress, i)).to.equal(predicted[i]);
      const clone = await ethers.getContractAt("CollateralSilo", predicted[2]);
      expect(await clone.factory()).to.equal(await factory.getAddress());
      expect(await clone.token()).to.equal(tokenAddress);
      expect(await clone.initialised()).to.equal(true);
    });

    it("never creates a clone past the cursor", async function () {
      await moveCursor(3n);
      // Asking for more than is missing creates only what is missing.
      expect(await factory.connect(anyone).createSilos.staticCall(tokenAddress, batch)).to.equal(4n);
      await factory.connect(anyone).createSilos(tokenAddress, batch);
      expect(await factory.getSiloCount(tokenAddress)).to.equal(4n);
      expect(await factory.missingSilos(tokenAddress)).to.equal(0n);
      await expect(factory.connect(anyone).createSilos(tokenAddress, 1n)).to.be.revertedWith("Nothing to create");
    });

    it("has nothing to create once a deposit has used the cursor's silo", async function () {
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10"));
      expect(await factory.missingSilos(tokenAddress)).to.equal(0n);
      await expect(factory.connect(anyone).createSilos(tokenAddress, 1n)).to.be.revertedWith("Nothing to create");
    });

    it("refuses a count of zero or above the batch maximum", async function () {
      await moveCursor(64n);
      await expect(factory.connect(anyone).createSilos(tokenAddress, 0n)).to.be.revertedWith("Invalid count");
      await expect(factory.connect(anyone).createSilos(tokenAddress, batch + 1n)).to.be.revertedWith("Invalid count");
    });

    it("moves no cursor, no floor and no balance", async function () {
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("250"));
      await moveCursor(20n);
      const cursor = await factory.currentSiloIndex(tokenAddress);
      const floor = await factory.minSiloIndex(tokenAddress);
      await factory.connect(anyone).createSilos(tokenAddress, batch);
      expect(await factory.currentSiloIndex(tokenAddress)).to.equal(cursor);
      expect(await factory.minSiloIndex(tokenAddress)).to.equal(floor);
      expect(await factory.totalCollateral(tokenAddress)).to.equal(ethers.parseEther("250"));
      expect(await factory.tokensHeld()).to.equal(1n);
    });

    it("leaves withdrawals working across a filled gap, and the cursor above the floor", async function () {
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("250")); // silos 0, 1, 2
      await moveCursor(40n); // cursor 42
      while ((await factory.missingSilos(tokenAddress)) > 0n) {
        await factory.connect(anyone).createSilos(tokenAddress, batch);
      }
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("30")); // silo 42

      // Reaches below the skipped run for the balance the top silo cannot cover.
      await factory.connect(vaultRole).withdraw(tokenAddress, anyone.address, ethers.parseEther("130"));
      expect(await token.balanceOf(anyone.address)).to.equal(ethers.parseEther("130"));
      expect(await factory.totalCollateral(tokenAddress)).to.equal(ethers.parseEther("150"));
      // The rewind stops at the index governance set.
      expect(await factory.currentSiloIndex(tokenAddress)).to.equal(42n);
    });

    it("keeps withdrawals working while the gap is still open, then fills it and deposits", async function () {
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("250")); // silos 0, 1, 2
      await moveCursor(70n); // cursor 72, silos 3 to 72 missing
      expect(await factory.missingSilos(tokenAddress)).to.equal(70n);

      // The walk starts at the highest silo that exists and the cursor stays at its floor.
      await factory.connect(vaultRole).withdraw(tokenAddress, anyone.address, ethers.parseEther("120"));
      expect(await factory.totalCollateral(tokenAddress)).to.equal(ethers.parseEther("130"));
      expect(await factory.currentSiloIndex(tokenAddress)).to.equal(72n);
      expect(await factory.missingSilos(tokenAddress)).to.equal(70n);

      // Part filled: a deposit creates the rest itself.
      await factory.connect(anyone).createSilos(tokenAddress, batch);
      await factory.connect(anyone).createSilos(tokenAddress, 5n);
      expect(await factory.missingSilos(tokenAddress)).to.equal(49n);
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10"));
      expect(await factory.getSiloCount(tokenAddress)).to.equal(73n);
      expect(await token.balanceOf(await factory.getSilo(tokenAddress, 72))).to.equal(ethers.parseEther("10"));
      // Everything is still withdrawable, across the skipped run.
      await factory.connect(vaultRole).withdraw(tokenAddress, anyone.address, ethers.parseEther("140"));
      expect(await factory.totalCollateral(tokenAddress)).to.equal(0n);
      expect(await factory.isEmpty()).to.equal(true);
    });

    it("fills a gap whose silos an issuer froze before they existed", async function () {
      const frozenToken = await (await ethers.getContractFactory("MockERC20Freezable")).deploy("Pax Gold", "PAXG");
      const frozen = await frozenToken.getAddress();
      await frozenToken.mint(vaultRole.address, ethers.parseEther("1000"));
      await frozenToken.connect(vaultRole).approve(await factory.getAddress(), ethers.MaxUint256);
      await factory.connect(vaultRole).deposit(frozen, ethers.parseEther("10")); // silo 0

      // The issuer freezes the next twenty predictable silo addresses.
      for (let i = 1; i <= 20; i++) {
        await frozenToken.setFrozen(await factory.predictSiloAddress(frozen, i), true);
      }
      await factory.connect(vaultRole).withdraw(frozen, anyone.address, ethers.parseEther("10"));
      await frozenToken.setFrozen(await factory.predictSiloAddress(frozen, 0), true);
      await expect(factory.connect(vaultRole).deposit(frozen, ethers.parseEther("10"))).to.be.revertedWith(
        "Too many unusable silos"
      );

      await factory.connect(admin).setCurrentSiloIndex(frozen, 21n);
      // Creating a clone moves no token, so a frozen address is no obstacle.
      await factory.connect(anyone).createSilos(frozen, batch);
      await factory.connect(anyone).createSilos(frozen, batch);
      expect(await factory.missingSilos(frozen)).to.equal(0n);
      await factory.connect(vaultRole).deposit(frozen, ethers.parseEther("10"));
      expect(await frozenToken.balanceOf(await factory.getSilo(frozen, 21))).to.equal(ethers.parseEther("10"));
    });

    it("refuses an address the factory has never seen, and creates nothing for it", async function () {
      const junk = ethers.Wallet.createRandom().address;
      expect(await factory.missingSilos(junk)).to.equal(0n);
      await expect(factory.connect(anyone).createSilos(junk, 1n)).to.be.revertedWith("Unknown token");
      await expect(factory.connect(anyone).createSilos(junk, batch)).to.be.revertedWith("Unknown token");
      expect(await factory.getSiloCount(junk)).to.equal(0n);
      // A real token contract nobody has deposited is no different.
      const other = await (await ethers.getContractFactory("MockERC20")).deploy("Other", "OTH", 18);
      await expect(factory.connect(anyone).createSilos(await other.getAddress(), 1n)).to.be.revertedWith("Unknown token");
      expect(await factory.getSiloCount(await other.getAddress())).to.equal(0n);
    });

    it("leaves a listed token's first silo to its first deposit", async function () {
      // No deposit yet and no cursor move: nothing is reported missing and nobody can
      // create silo 0 ahead of the vault.
      expect(await factory.missingSilos(tokenAddress)).to.equal(0n);
      await expect(factory.connect(anyone).createSilos(tokenAddress, 1n)).to.be.revertedWith("Unknown token");
      expect(await factory.getSiloCount(tokenAddress)).to.equal(0n);

      const predicted = await factory.predictSiloAddress(tokenAddress, 0);
      await expect(factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10")))
        .to.emit(factory, "SiloCreated")
        .withArgs(tokenAddress, predicted, 0);
      expect(await factory.getSiloCount(tokenAddress)).to.equal(1n);
      expect(await token.balanceOf(predicted)).to.equal(ethers.parseEther("10"));
      expect(await factory.missingSilos(tokenAddress)).to.equal(0n);
    });

    it("works for a token with no silos once governance has moved its cursor", async function () {
      await factory.connect(admin).setCurrentSiloIndex(tokenAddress, 5n);
      expect(await factory.missingSilos(tokenAddress)).to.equal(6n);
      await factory.connect(anyone).createSilos(tokenAddress, 4n);
      expect(await factory.getSiloCount(tokenAddress)).to.equal(4n);
      expect(await factory.missingSilos(tokenAddress)).to.equal(2n);
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10"));
      expect(await factory.getSiloCount(tokenAddress)).to.equal(6n);
      expect(await token.balanceOf(await factory.getSilo(tokenAddress, 5))).to.equal(ethers.parseEther("10"));
    });

    it("reports nothing missing in ordinary running, through fills, rollovers and withdrawals", async function () {
      for (const amount of ["10", "250", "95", "400"]) {
        await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther(amount));
        expect(await factory.missingSilos(tokenAddress)).to.equal(0n);
      }
      await factory.connect(vaultRole).withdraw(tokenAddress, anyone.address, ethers.parseEther("600"));
      expect(await factory.missingSilos(tokenAddress)).to.equal(0n);
      await expect(factory.connect(anyone).createSilos(tokenAddress, 1n)).to.be.revertedWith("Nothing to create");
    });

    it("a one-step cursor move leaves one silo missing, which either the call or the deposit creates", async function () {
      await factory.connect(vaultRole).deposit(tokenAddress, ethers.parseEther("10"));
      await moveCursor(1n);
      expect(await factory.missingSilos(tokenAddress)).to.equal(1n);
      await factory.connect(anyone).createSilos(tokenAddress, batch);
      expect(await factory.missingSilos(tokenAddress)).to.equal(0n);
      // A second caller who raced the first finds nothing left.
      await expect(factory.connect(anyone).createSilos(tokenAddress, 1n)).to.be.revertedWith("Nothing to create");
    });
  });
});

describe("Deployment verifier: silo gap checks", function () {
  async function setup() {
    const [admin, anyone] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("Pax Gold", "PAXG", 18);
    const factory = await (await ethers.getContractFactory("SiloFactory")).deploy(ethers.parseEther("100"));
    const tokens = [{ label: "PAXG", address: await token.getAddress() }];
    return { admin, anyone, factory, tokens };
  }
  const failed = (checks: SiloGapCheck[]) => checks.filter((c) => !c.pass).map((c) => c.name);

  it("passes a fresh factory, whose first deposit creates its own silo", async function () {
    const { factory, tokens } = await setup();
    const checks = await siloGapChecks(factory, tokens);
    expect(failed(checks)).to.deep.equal([]);
    expect(await factory.missingSilos(tokens[0].address)).to.equal(0n);
    expect(checks.map((c) => c.name)).to.deep.equal([
      "ops:siloFactory.createSilos-batch-16",
      "ops:siloFactory.PAXG.no-silo-gap",
    ]);
  });

  it("fails while a moved cursor has an open gap, names the fix, and passes once it is filled", async function () {
    const { admin, anyone, factory, tokens } = await setup();
    await factory.connect(admin).setCurrentSiloIndex(tokens[0].address, 20n);
    const open = await siloGapChecks(factory, tokens);
    expect(failed(open)).to.deep.equal(["ops:siloFactory.PAXG.no-silo-gap"]);
    expect(open[1].detail).to.include("21 silos are missing").and.to.include(`createSilos(${tokens[0].address}, 16)`);

    await factory.connect(anyone).createSilos(tokens[0].address, 16n);
    await factory.connect(anyone).createSilos(tokens[0].address, 16n);
    expect(failed(await siloGapChecks(factory, tokens))).to.deep.equal([]);
  });

  it("fails a factory that has no batch call, or another batch size", async function () {
    const missing = await siloGapChecks(
      { MAX_CREATE_BATCH: () => Promise.reject(new Error("no such function")), missingSilos: () => Promise.resolve(0n) },
      []
    );
    expect(failed(missing)).to.deep.equal(["ops:siloFactory.createSilos-batch-16"]);
    const other = await siloGapChecks({ MAX_CREATE_BATCH: () => Promise.resolve(64n), missingSilos: () => Promise.resolve(0n) }, []);
    expect(other[0].detail).to.equal("MAX_CREATE_BATCH is 64, expected 16");
  });

  it("fails on a single missing silo: nothing is missing in ordinary running", async function () {
    const one = await siloGapChecks(
      { MAX_CREATE_BATCH: () => Promise.resolve(16n), missingSilos: () => Promise.resolve(1n) },
      [{ label: "PAXG", address: "0x0000000000000000000000000000000000000001" }]
    );
    expect(failed(one)).to.deep.equal(["ops:siloFactory.PAXG.no-silo-gap"]);
    expect(one[1].detail).to.include("1 silo is missing");
  });
});
