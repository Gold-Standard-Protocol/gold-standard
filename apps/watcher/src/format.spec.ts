import { DEPLOYMENT, EXPLORER, hash, mintLog } from './fixtures';
import { formatEvent, formatPpm } from './format';
import type { WatchedLog } from './format';
import { findEventRule } from './rules';
import type { ContractKey, EventRule } from './rules';

const format = (contract: ContractKey, log: WatchedLog): { severity: string; text: string } =>
  formatEvent(DEPLOYMENT, EXPLORER, contract, findEventRule(contract, log.eventName) as EventRule, log);

describe('formatEvent', () => {
  it('writes a mint as a note with the amount in GSUSD and the transaction link', () => {
    const message = format('vault', mintLog(26_506_100, 4, 7));
    expect(message.severity).toBe('note');
    expect(message.text).toBe(
      [
        'NOTE: DebtMinted on Vault',
        'GSUSD was minted.',
        'user: 0xa30072Ad3E6B5A62ba86655128985D40cb681a5f',
        'amount: 1551 GSUSD',
        'Block 26506100',
        `https://etherscan.io/tx/${hash(7)}`,
      ].join('\n')
    );
  });

  it('names a recognised role and the contracts among the arguments', () => {
    const message = format('stablecoin', {
      address: DEPLOYMENT.addresses.stablecoin,
      eventName: 'RoleGranted',
      args: {
        role: '0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6',
        account: DEPLOYMENT.addresses.vault,
        sender: DEPLOYMENT.addresses.timelock,
      },
      blockNumber: 1,
      logIndex: 0,
      transactionHash: hash(1),
    });
    expect(message.severity).toBe('page');
    expect(message.text).toContain('PAGE: RoleGranted on GSUSD');
    expect(message.text).toContain('role: MINTER_ROLE');
    expect(message.text).toContain(`account: ${DEPLOYMENT.addresses.vault} (Vault)`);
    expect(message.text).toContain(`sender: ${DEPLOYMENT.addresses.timelock} (Timelock)`);
  });

  it('keeps an unrecognised role as its hash', () => {
    const role = `0x${'ab'.repeat(32)}`;
    const message = format('vault', {
      address: DEPLOYMENT.addresses.vault,
      eventName: 'RoleGranted',
      args: { role, account: DEPLOYMENT.addresses.vault, sender: DEPLOYMENT.addresses.vault },
      blockNumber: 1,
      logIndex: 0,
      transactionHash: hash(1),
    });
    expect(message.text).toContain(`role: ${role}`);
  });

  const proposal = (data: string): WatchedLog => ({
    address: DEPLOYMENT.addresses.timelock,
    eventName: 'CallScheduled',
    args: { id: hash(9), index: 0n, target: DEPLOYMENT.addresses.stabilityPool, value: 0n, data, predecessor: hash(0), delay: 172_800n },
    blockNumber: 2,
    logIndex: 1,
    transactionHash: hash(2),
  });

  it('raises the alarm line for a proposal that grants a role, naming its target', () => {
    const text = format('timelock', proposal(`0x2f2ff15d${'00'.repeat(64)}`)).text;
    expect(text).toContain(`target: ${DEPLOYMENT.addresses.stabilityPool} (Stability pool)`);
    expect(text).toContain('delay: 172800 seconds');
    expect(text).toContain('ALARM: the call is grantRole (0x2f2ff15d)');
  });

  it('shows the selector of any other proposal and cuts long call data', () => {
    const text = format('timelock', proposal(`0xdeadbeef${'11'.repeat(400)}`)).text;
    expect(text).toContain('Call selector: 0xdeadbeef');
    expect(text).not.toContain('ALARM');
    expect(text).toContain('… (404 bytes)');
    expect(text.length).toBeLessThan(900);
  });

  it('writes a freeze deadline as a date and leaves gold amounts raw', () => {
    const freeze = format('oracle', {
      address: DEPLOYMENT.addresses.oracle,
      eventName: 'TokenFrozen',
      args: { token: '0x45804880De22913dAFE09f4980848ECE6EcbAf78', by: DEPLOYMENT.addresses.timelock, until: 1_795_000_000n },
      blockNumber: 3,
      logIndex: 0,
      transactionHash: hash(3),
    }).text;
    expect(freeze).toContain('until: 2026-11-18T11:06:40.000Z (1795000000)');
    const routing = format('vault', {
      address: DEPLOYMENT.addresses.vault,
      eventName: 'ReserveRoutingFailed',
      args: { token: '0x45804880De22913dAFE09f4980848ECE6EcbAf78', amount: 5n * 10n ** 16n },
      blockNumber: 3,
      logIndex: 1,
      transactionHash: hash(3),
    }).text;
    expect(routing).toContain('amount: 50000000000000000');
    expect(routing).not.toContain('GSUSD');
  });
});

describe('formatPpm', () => {
  it('writes parts per million as a percentage', () => {
    expect(formatPpm(1_538_105n)).toBe('153.81%');
    expect(formatPpm(116_972n)).toBe('11.69%');
    expect(formatPpm(50_000n)).toBe('5.00%');
    expect(formatPpm(1_250_000n)).toBe('125.00%');
  });
});
