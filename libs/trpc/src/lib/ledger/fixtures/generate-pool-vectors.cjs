/**
 * Regenerates poolMirrorVectors.json from the StabilityPool contract itself, so the pool
 * mirror in ../poolMirror.ts is tested against the Solidity and not against a second
 * implementation of the same idea. Run it from the contracts folder, which it only reads:
 *
 *   cd contracts
 *   npx hardhat run ../libs/trpc/src/lib/ledger/fixtures/generate-pool-vectors.cjs --no-compile
 *
 * The run uses the in-process Hardhat network and the production fixture of the contract
 * tests, with the deployer standing in for the vault. Each step records the event the
 * replay consumes and, after it, the pool globals and every depositor's effective deposit.
 */
const { createRequire } = require('node:module');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const requireFromContracts = createRequire(`${process.cwd()}/`);
const { ethers } = requireFromContracts('hardhat');
const { productionSystem } = requireFromContracts('./test/helpers/productionSystem');

const ether = (value) => ethers.parseEther(value);

async function main() {
  const s = await productionSystem();
  const pool = s.stabilityPool;
  const poolAddress = await pool.getAddress();
  const paxg = await s.paxg.getAddress();
  const signers = await ethers.getSigners();
  const users = { alice: s.alice, bob: s.bob, charlie: s.charlie, dave: signers[8], erin: signers[9] };

  await pool.grantRole(await pool.VAULT_ROLE(), s.deployer.address);
  await s.paxg.mint(s.deployer.address, ether('1000'));
  for (const user of Object.values(users)) {
    await s.stablecoin.mint(user.address, ether('100000000'));
    await s.stablecoin.connect(user).approve(poolAddress, ethers.MaxUint256);
  }

  const steps = [];
  const record = async (event) => {
    const deposits = {};
    for (const [name, user] of Object.entries(users)) {
      deposits[name] = (await pool.getEffectiveDeposit(user.address)).toString();
    }
    steps.push({
      event,
      pool: {
        P: (await pool.P()).toString(),
        scale: (await pool.currentScale()).toString(),
        epoch: (await pool.currentEpoch()).toString(),
        total: (await pool.totalDeposits()).toString(),
      },
      deposits,
    });
  };

  const emitted = async (tx, name) => {
    const receipt = await tx.wait();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== poolAddress.toLowerCase()) continue;
      const parsed = pool.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed.args;
    }
    throw new Error(`no ${name} event in the transaction`);
  };

  const deposit = async (name, amount) => {
    const args = await emitted(await pool.connect(users[name]).deposit(amount), 'Deposited');
    await record({ kind: 'deposit', account: name, amount: args.amount.toString() });
  };
  const withdraw = async (name, amount) => {
    const args = await emitted(await pool.connect(users[name]).withdraw(amount), 'Withdrawn');
    await record({ kind: 'withdraw', account: name, amount: args.amount.toString() });
  };
  const claim = async (name) => {
    await emitted(await pool.connect(users[name]).claimCollateral(paxg), 'CollateralClaimed');
    await record({ kind: 'claim', account: name });
  };
  const absorb = async (debt) => {
    // As the vault sends a liquidation: the gold reaches the pool, then the debt is absorbed.
    await (await s.paxg.transfer(poolAddress, ether('0.01'))).wait();
    const args = await emitted(await pool.absorbLiquidationPrefunded(paxg, debt), 'LiquidationAbsorbed');
    await record({ kind: 'absorb', debt: args.debtAbsorbed.toString() });
  };
  /** Absorbs all but one part in `keepOneIn` of the pool. */
  const absorbAllBut = async (keepOneIn) => {
    const total = await pool.totalDeposits();
    await absorb(total - total / keepOneIn);
  };

  // Plain deposits, an absorption, a claim that re-anchors, a late depositor, withdrawals.
  await deposit('alice', ether('1000'));
  await deposit('bob', ether('500') + 123456789n);
  await absorb(ether('300'));
  await claim('alice');
  await deposit('charlie', ether('777.123456789012345678'));
  await withdraw('bob', ether('100'));
  await absorb(ether('411.5') + 7n);
  await deposit('alice', 3n);
  await withdraw('charlie', ether('1000000'));
  await deposit('charlie', ether('250'));

  // Two absorptions of 99.999% push P below the scale factor: one scale change.
  await absorbAllBut(100000n);
  await absorbAllBut(100000n);
  // Alice, Bob and Charlie are one scale behind; Dave joins at the new scale.
  await deposit('dave', ether('2000000'));
  await claim('bob');
  await absorb(ether('1234.5'));
  await withdraw('alice', 1n);

  // A second scale change: Charlie, never re-anchored, is two scales behind and holds nothing.
  await absorbAllBut(100000n);
  await absorbAllBut(100000n);
  await deposit('erin', ether('5000'));
  await absorb(ether('17'));
  await claim('charlie');
  await withdraw('dave', ether('1'));

  // A near-total drain resets the epoch: every earlier depositor holds nothing.
  await absorbAllBut(1000000000000n);
  await deposit('alice', ether('42'));
  await claim('erin');
  await withdraw('dave', ether('5'));
  await absorb(ether('10'));
  await withdraw('alice', ether('1000'));

  const out = join(__dirname, 'poolMirrorVectors.json');
  writeFileSync(out, `${JSON.stringify({ source: 'contracts/src/core/StabilityPool.sol', steps }, null, 2)}\n`);
  console.info(`wrote ${steps.length} steps to ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
