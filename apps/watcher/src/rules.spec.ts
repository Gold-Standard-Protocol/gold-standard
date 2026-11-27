import { keccak256, toBytes, toEventSelector } from 'viem';
import type { AbiEvent } from 'viem';

// The published ABIs are the reference; the watcher itself never imports the library.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { goldOracleAbi } from '../../../libs/constants/src/lib/abis/GoldOracle';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { goldStabilityReserveAbi } from '../../../libs/constants/src/lib/abis/GoldStabilityReserve';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { goldVaultAbi } from '../../../libs/constants/src/lib/abis/GoldVault';
import {
  CONTRACT_KEYS,
  EVENT_RULES,
  findEventRule,
  GRANT_ROLE_SELECTOR,
  ROLE_NAMES,
  RULE_COUNT,
  WATCHED_EVENTS,
} from './rules';

const published = ([...goldVaultAbi, ...goldOracleAbi, ...goldStabilityReserveAbi] as readonly { type: string }[]).filter(
  (item) => item.type === 'event'
) as unknown as AbiEvent[];
const describeEvent = (event: AbiEvent): string =>
  `${event.name}(${event.inputs.map((input) => `${input.type}${input.indexed ? ' indexed' : ''} ${input.name}`).join(',')})`;

// OpenZeppelin's TimelockController is not among the published ABIs; these are its topics.
const TIMELOCK_TOPICS: Record<string, string> = {
  CallScheduled: '0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca',
  CallExecuted: '0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58',
  Cancelled: '0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70',
};

describe('watched events', () => {
  it.each(WATCHED_EVENTS.map((event) => [event.name, event] as const))(
    '%s matches the published definition',
    (name, event) => {
      if (name in TIMELOCK_TOPICS) {
        expect(toEventSelector(event)).toBe(TIMELOCK_TOPICS[name]);
        return;
      }
      const reference = published.find((candidate) => candidate.name === name);
      expect(reference).toBeDefined();
      expect(describeEvent(event)).toBe(describeEvent(reference as AbiEvent));
    }
  );

  it('has no two events with one name, so a rule names exactly one definition', () => {
    const names = WATCHED_EVENTS.map((event) => event.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('rules', () => {
  it('numbers the event rules 1 to 14 and counts the two threshold rules', () => {
    expect(EVENT_RULES.map((rule) => rule.id)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(RULE_COUNT).toBe(16);
  });

  it('uses every watched event in some rule and only known contracts', () => {
    const used = new Set(EVENT_RULES.flatMap((rule) => rule.events));
    expect([...used].sort()).toEqual(WATCHED_EVENTS.map((event) => event.name).sort());
    for (const rule of EVENT_RULES) for (const key of rule.contracts) expect(CONTRACT_KEYS).toContain(key);
  });

  it('pages for a pause, a proposal and a role grant, and notes a mint', () => {
    expect(findEventRule('vault', 'Paused')?.severity).toBe('page');
    expect(findEventRule('timelock', 'CallScheduled')?.severity).toBe('page');
    expect(findEventRule('stablecoin', 'RoleGranted')?.severity).toBe('page');
    expect(findEventRule('vault', 'DebtMinted')?.severity).toBe('note');
  });

  it('has no rule for an event on a contract the rule does not name', () => {
    expect(findEventRule('reserve', 'Paused')).toBeUndefined();
    expect(findEventRule('vault', 'CallScheduled')).toBeUndefined();
  });

  it('names the roles by their hashes', () => {
    expect(ROLE_NAMES[keccak256(toBytes('MINTER_ROLE'))]).toBe('MINTER_ROLE');
    expect(ROLE_NAMES[keccak256(toBytes('VAULT_ROLE'))]).toBe('VAULT_ROLE');
    expect(keccak256(toBytes('grantRole(bytes32,address)')).slice(0, 10)).toBe(GRANT_ROLE_SELECTOR);
  });
});
