import type * as NodeCrypto from 'node:crypto';
import { getAddress } from 'viem';
import type { Address } from 'viem';

// The default window start must come from node:crypto. A spy that runs the real draw
// unless a test queues a value lets one test prove which function chose the start page
// and with which page count, which freezing the wall clock alone could not show.
const { randomInt: realRandomInt } = jest.requireActual<typeof NodeCrypto>('node:crypto');
const mockRandomInt = jest.fn<number, [number]>((max) => realRandomInt(max));
jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof NodeCrypto>('node:crypto'),
  randomInt: (max: number) => mockRandomInt(max),
}));

import {
  combineVaultOwnerSources,
  createRegistryVaultOwnerSource,
  MAX_REGISTRY_OWNERS,
  MAX_TRUSTED_OWNER_COUNT,
  REGISTRY_OWNER_PAGE,
} from './registryOwnerSource';
import type { OwnerSourceReading, RegistryOwnerSourceOptions } from './registryOwnerSource';
import type { KeeperContractCall, KeeperLogger, KeeperReadClient } from './ports';

const REGISTRY = '0x1111111111111111111111111111111111111111' as Address;

const ownerAt = (index: number): Address =>
  getAddress(`0x${(index + 1).toString(16).padStart(40, '0')}`);

const createStubLogger = (): {
  log: KeeperLogger;
  warns: string[];
  errors: string[];
  errorReasons: string[];
} => {
  const warns: string[] = [];
  const errors: string[] = [];
  const errorReasons: string[] = [];
  return {
    log: {
      info: () => undefined,
      warn: (event, fields) => warns.push(`${event}:${String(fields?.['job'])}`),
      error: (event, fields) => {
        errors.push(`${event}:${String(fields?.['job'])}`);
        errorReasons.push(String(fields?.['reason']));
      },
    },
    warns,
    errors,
    errorReasons,
  };
};

/** Starts the first window at the head of the listing, so a test can name the pages read. */
const FROM_HEAD = { pickStartPage: () => 0 };

const createRegistryRead = (
  owners: readonly Address[],
  calls: KeeperContractCall[]
): KeeperReadClient => ({
  readContract: async (call) => {
    calls.push(call);
    if (call.functionName === 'vaultOwnerCount') return BigInt(owners.length);
    const [offset, limit] = call.args as readonly [bigint, bigint];
    return owners.slice(Number(offset), Number(offset + limit));
  },
});

/** The offset of every page a list of calls asked for, in call order. */
const pageOffsets = (calls: readonly KeeperContractCall[]): number[] =>
  calls
    .filter((call) => call.functionName === 'vaultOwners')
    .map((call) => Number((call.args as readonly [bigint, bigint])[0]));

describe('createRegistryVaultOwnerSource', () => {
  it('returns an empty list and reads no page for an empty registry', async () => {
    const calls: KeeperContractCall[] = [];
    const { log, warns } = createStubLogger();
    const source = createRegistryVaultOwnerSource(REGISTRY, createRegistryRead([], calls), log);
    await expect(source.getOwners()).resolves.toEqual([]);
    expect(calls.map((call) => call.functionName)).toEqual(['vaultOwnerCount']);
    expect(warns).toEqual([]);
  });

  it('requests every page at once rather than one round trip per page', async () => {
    const owners = Array.from({ length: REGISTRY_OWNER_PAGE * 3 + 1 }, (_, i) => ownerAt(i));
    const { log } = createStubLogger();
    let inFlight = 0;
    let peak = 0;
    const read: KeeperReadClient = {
      readContract: async (call) => {
        if (call.functionName === 'vaultOwnerCount') return BigInt(owners.length);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const [offset, limit] = call.args as readonly [bigint, bigint];
        return owners.slice(Number(offset), Number(offset + limit));
      },
    };
    const source = createRegistryVaultOwnerSource(REGISTRY, read, log);
    await expect(source.getOwners()).resolves.toEqual(owners);
    expect(peak).toBe(4);
  });

  it('walks the registry in bounded pages and checksums every owner', async () => {
    const owners = Array.from({ length: REGISTRY_OWNER_PAGE + 3 }, (_, i) => ownerAt(i));
    const calls: KeeperContractCall[] = [];
    const { log } = createStubLogger();
    const lowercased = owners.map((owner) => owner.toLowerCase() as Address);
    const source = createRegistryVaultOwnerSource(
      REGISTRY,
      createRegistryRead(lowercased, calls),
      log
    );
    await expect(source.getOwners()).resolves.toEqual(owners);
    const pages = calls.filter((call) => call.functionName === 'vaultOwners');
    expect(pages.map((call) => call.args)).toEqual([
      [0n, BigInt(REGISTRY_OWNER_PAGE)],
      [BigInt(REGISTRY_OWNER_PAGE), BigInt(REGISTRY_OWNER_PAGE)],
    ]);
    expect(calls.every((call) => call.address === REGISTRY)).toBe(true);
  });

  it('degrades to an empty list with a warn when the registry read fails', async () => {
    const { log, warns } = createStubLogger();
    const read: KeeperReadClient = {
      readContract: async () => {
        throw new Error('rpc down');
      },
    };
    const source = createRegistryVaultOwnerSource(REGISTRY, read, log);
    await expect(source.getOwners()).resolves.toEqual([]);
    expect(warns).toEqual(['keeper.job-error:vault-registry-owner-source']);
  });

  it('treats a malformed count as a failure rather than a silent empty set', async () => {
    const { log, warns } = createStubLogger();
    const read: KeeperReadClient = { readContract: async () => 'not a count' };
    const source = createRegistryVaultOwnerSource(REGISTRY, read, log);
    await expect(source.getOwners()).resolves.toEqual([]);
    expect(warns).toHaveLength(1);
  });

  // The bound used to be a warn. A count past the sanity bound, and any registry longer
  // than one tick's window, is now reported at error.
  it('caps the walk when a hostile RPC reports an absurd owner count', async () => {
    const calls: KeeperContractCall[] = [];
    const { log, warns, errors } = createStubLogger();
    const read: KeeperReadClient = {
      readContract: async (call) => {
        calls.push(call);
        if (call.functionName === 'vaultOwnerCount') return 2n ** 256n - 1n;
        return [ownerAt(calls.length)];
      },
    };
    const source = createRegistryVaultOwnerSource(REGISTRY, read, log);
    const owners = await source.getOwners();
    const pages = calls.filter((call) => call.functionName === 'vaultOwners');
    expect(pages).toHaveLength(MAX_REGISTRY_OWNERS / REGISTRY_OWNER_PAGE);
    expect(owners).toHaveLength(pages.length);
    expect(warns).toEqual([]);
    expect(errors).toEqual([
      'keeper.job-error:vault-registry-owner-source',
      'keeper.job-error:vault-registry-owner-source',
    ]);
  });

  it('drops the zero address and non-address entries from a page', async () => {
    const { log, warns } = createStubLogger();
    const a = ownerAt(0);
    const read: KeeperReadClient = {
      readContract: async (call) =>
        call.functionName === 'vaultOwnerCount'
          ? 3n
          : [a, `0x${'0'.repeat(40)}`, 'not-an-address'],
    };
    const source = createRegistryVaultOwnerSource(REGISTRY, read, log);
    await expect(source.getOwners()).resolves.toEqual([a]);
    expect(warns).toEqual([]);
  });

  it('keeps the other pages when one page fails', async () => {
    const owners = Array.from({ length: REGISTRY_OWNER_PAGE + 1 }, (_, i) => ownerAt(i));
    const { log, warns } = createStubLogger();
    const read: KeeperReadClient = {
      readContract: async (call) => {
        if (call.functionName === 'vaultOwnerCount') return BigInt(owners.length);
        const [offset] = call.args as readonly [bigint, bigint];
        if (offset > 0n) throw new Error('rpc blip');
        return owners.slice(0, REGISTRY_OWNER_PAGE);
      },
    };
    const source = createRegistryVaultOwnerSource(REGISTRY, read, log);
    await expect(source.getOwners()).resolves.toEqual(owners.slice(0, REGISTRY_OWNER_PAGE));
    expect(warns).toEqual(['keeper.job-error:vault-registry-owner-source']);
  });
});

describe('createRegistryVaultOwnerSource against a hostile RPC', () => {
  const run = async (
    count: unknown,
    page: (offset: bigint) => unknown
  ): Promise<{ owners: Address[]; reads: number }> => {
    const { log } = createStubLogger();
    let reads = 0;
    const read: KeeperReadClient = {
      readContract: async ({ functionName, args }) => {
        reads++;
        return functionName === 'vaultOwnerCount' ? count : page(args?.[0] as bigint);
      },
    };
    const owners = await createRegistryVaultOwnerSource(REGISTRY, read, log).getOwners();
    return { owners, reads };
  };

  it('takes at most the requested page size from an oversized page', async () => {
    const oversized = Array.from({ length: REGISTRY_OWNER_PAGE * 3 }, (_, index) =>
      ownerAt(index)
    );
    const { owners } = await run(1n, () => oversized);
    expect(owners).toHaveLength(REGISTRY_OWNER_PAGE);
    expect(owners[0]).toBe(ownerAt(0));
  });

  it('caps the total at MAX_REGISTRY_OWNERS even when every page is full', async () => {
    const full = Array.from({ length: REGISTRY_OWNER_PAGE }, (_, index) => ownerAt(index));
    const { owners, reads } = await run(2n ** 256n - 1n, () => full);
    expect(owners).toHaveLength(MAX_REGISTRY_OWNERS);
    expect(reads).toBe(1 + MAX_REGISTRY_OWNERS / REGISTRY_OWNER_PAGE);
  });

  it('rejects counts that are not non-negative bigints', async () => {
    for (const bad of [Number.NaN, -1n, '5', 1.5, null, undefined, {}]) {
      const { owners } = await run(bad, () => [ownerAt(1)]);
      expect(owners).toEqual([]);
    }
  });

  it('drops junk entries from a page and leaves deduplication to the union', async () => {
    const dup = ownerAt(0x5001);
    const { owners } = await run(5n, () => [
      dup,
      dup.toLowerCase(),
      5,
      [dup],
      '0x00',
      `0x${'0'.repeat(40)}`,
      { toString: () => dup },
      null,
    ]);
    expect(owners).toEqual([dup, dup]);
    const combined = await combineVaultOwnerSources(
      [{ getOwners: async () => owners }],
      createStubLogger().log
    ).getOwners();
    expect(combined).toEqual([dup]);
  });

  it('fails only the page that is not an array', async () => {
    const { owners } = await run(1_000n, (offset) => (offset === 0n ? 'oops' : [ownerAt(2)]));
    expect(owners).toEqual([ownerAt(2)]);
  });
});

// The keeper used to walk only the first 20,000 VaultRegistry entries. Registry membership
// costs one wei of collateral, so a fixed head of the
// listing let dust owners hide every vault listed after them. The window bounds the work
// of one tick, never which owners are ever read.
describe('createRegistryVaultOwnerSource over a registry longer than one tick', () => {
  const pagesPerTick = MAX_REGISTRY_OWNERS / REGISTRY_OWNER_PAGE;

  const createSource = (
    owners: readonly Address[],
    options: RegistryOwnerSourceOptions = FROM_HEAD
  ) => {
    const calls: KeeperContractCall[] = [];
    const logger = createStubLogger();
    const source = createRegistryVaultOwnerSource(
      REGISTRY,
      createRegistryRead(owners, calls),
      logger.log,
      options
    );
    return { source, calls, ...logger };
  };

  it('resumes where the previous tick stopped, so the owner just past the window is read on the second tick', async () => {
    const owners = Array.from({ length: MAX_REGISTRY_OWNERS + 1 }, (_, i) => ownerAt(i));
    const { source } = createSource(owners);

    const first = await source.getOwners();
    const second = await source.getOwners();

    expect(first).toEqual(owners.slice(0, MAX_REGISTRY_OWNERS));
    expect(second).toContain(owners[MAX_REGISTRY_OWNERS]);
    expect(second.length).toBeLessThanOrEqual(MAX_REGISTRY_OWNERS);
  });

  it('reaches every listed owner within ceil(count / window) ticks and never reads more than the window in one', async () => {
    const owners = Array.from(
      { length: MAX_REGISTRY_OWNERS * 2 + REGISTRY_OWNER_PAGE * 3 + 7 },
      (_, i) => ownerAt(i)
    );
    const { source, calls } = createSource(owners);
    const seen = new Set<Address>();

    for (let tick = 0; tick < Math.ceil(owners.length / MAX_REGISTRY_OWNERS); tick++) {
      calls.length = 0;
      const walked = await source.getOwners();
      expect(walked.length).toBeLessThanOrEqual(MAX_REGISTRY_OWNERS);
      expect(calls.filter((call) => call.functionName === 'vaultOwners')).toHaveLength(pagesPerTick);
      walked.forEach((owner) => seen.add(owner));
    }

    expect(seen.size).toBe(owners.length);
  });

  it('reports a registry longer than the window at error level on every tick', async () => {
    const owners = Array.from({ length: MAX_REGISTRY_OWNERS + 1 }, (_, i) => ownerAt(i));
    const { source, warns, errors } = createSource(owners);

    await source.getOwners();
    await source.getOwners();

    expect(warns).toEqual([]);
    expect(errors).toEqual([
      'keeper.job-error:vault-registry-owner-source',
      'keeper.job-error:vault-registry-owner-source',
    ]);
  });

  // A window that runs off the tail or meets a short last page reads fewer owners than
  // the window holds, and a wrapping window rereads some pages within one rotation. The
  // message must not promise an exact number read or an exact cadence.
  it('says how many owners a tick reads at most, where it wraps and how often each owner is read at least', async () => {
    const owners = Array.from({ length: MAX_REGISTRY_OWNERS + 1 }, (_, i) => ownerAt(i));
    const { source, errorReasons } = createSource(owners);

    const first = await source.getOwners();
    const second = await source.getOwners();

    expect(first).toHaveLength(MAX_REGISTRY_OWNERS);
    expect(second.length).toBeLessThan(MAX_REGISTRY_OWNERS);
    const [head, wrapped] = errorReasons;
    expect(errorReasons).toHaveLength(2);
    expect(head).toContain(
      `reading up to ${MAX_REGISTRY_OWNERS} from offset 0, so each owner is read at least once every 2 ticks`
    );
    expect(head).not.toContain('wrapping');
    expect(wrapped).toContain(
      `reading up to ${MAX_REGISTRY_OWNERS} from offset ${MAX_REGISTRY_OWNERS}, wrapping to the head of the listing, so each owner is read at least once every 2 ticks`
    );
    for (const reason of errorReasons) {
      expect(reason).not.toContain(`reading ${MAX_REGISTRY_OWNERS} from`);
      expect(reason).not.toContain('read once every');
    }
  });

  // The registry removes an owner by moving the last
  // owner into the freed slot (EnumerableSet swap and pop), so an owner the window has not
  // reached yet can land on a page it has already passed. The cadence holds only while the
  // listing is unchanged, and the message says so.
  it('qualifies the cadence: it holds while the listing is unchanged and a removal can delay an owner', async () => {
    const owners = Array.from({ length: MAX_REGISTRY_OWNERS + 1 }, (_, i) => ownerAt(i));
    const { source, errorReasons } = createSource(owners);

    await source.getOwners();

    expect(errorReasons).toHaveLength(1);
    expect(errorReasons[0]).toContain(
      'each owner is read at least once every 2 ticks while the listing is unchanged'
    );
    expect(errorReasons[0]).toContain(
      'a removal moves the last owner into the freed slot, which can delay that owner by up to one more rotation'
    );
  });

  // The wrap test covered a window that runs off the
  // tail, never one that ends exactly on the last page, where an off by one would claim a
  // wrap that never happens.
  it('does not claim a wrap for a window that ends exactly on the last page', async () => {
    const owners = Array.from({ length: MAX_REGISTRY_OWNERS * 2 }, (_, i) => ownerAt(i));
    const { source, calls, errorReasons } = createSource(owners, {
      pickStartPage: () => pagesPerTick,
    });

    const walked = await source.getOwners();

    expect(walked).toEqual(owners.slice(MAX_REGISTRY_OWNERS));
    expect(pageOffsets(calls)[0]).toBe(MAX_REGISTRY_OWNERS);
    expect(errorReasons).toHaveLength(1);
    expect(errorReasons[0]).toContain(`from offset ${MAX_REGISTRY_OWNERS}, so`);
    expect(errorReasons[0]).not.toContain('wrapping');
  });

  it('stays silent and reads from the start each tick while the registry fits the window', async () => {
    const owners = Array.from({ length: MAX_REGISTRY_OWNERS }, (_, i) => ownerAt(i));
    const { source, warns, errors } = createSource(owners);

    await expect(source.getOwners()).resolves.toEqual(owners);
    await expect(source.getOwners()).resolves.toEqual(owners);
    expect([...warns, ...errors]).toEqual([]);
  });

  it('walks a count past the sanity bound in bounded windows that still rotate', async () => {
    const offsets: bigint[] = [];
    const { log } = createStubLogger();
    const read: KeeperReadClient = {
      readContract: async ({ functionName, args }) => {
        if (functionName === 'vaultOwnerCount') return BigInt(MAX_TRUSTED_OWNER_COUNT) * 4n;
        const [offset] = args as readonly [bigint, bigint];
        offsets.push(offset);
        return [];
      },
    };
    const source = createRegistryVaultOwnerSource(REGISTRY, read, log, FROM_HEAD);

    await source.getOwners();
    const firstTick = [...offsets];
    offsets.length = 0;
    await source.getOwners();

    expect(firstTick).toHaveLength(pagesPerTick);
    expect(offsets).toHaveLength(pagesPerTick);
    expect(offsets[0]).toBe(BigInt(MAX_REGISTRY_OWNERS));
    expect(
      [...firstTick, ...offsets].every((offset) => offset < BigInt(MAX_TRUSTED_OWNER_COUNT))
    ).toBe(true);
  });

  // Dust deposits of one wei can list a
  // million owners for real, so the old bound of 1,000,000 skipped real owners for good
  // while its message blamed the RPC.
  it('reads owners past one million, the earlier bound', async () => {
    const reported = 1_000_001n;
    const offsets: bigint[] = [];
    const { log, errorReasons } = createStubLogger();
    const read: KeeperReadClient = {
      readContract: async ({ functionName, args }) => {
        if (functionName === 'vaultOwnerCount') return reported;
        const [offset] = args as readonly [bigint, bigint];
        offsets.push(offset);
        return [];
      },
    };
    const lastPage = Math.ceil(Number(reported) / REGISTRY_OWNER_PAGE) - 1;
    const source = createRegistryVaultOwnerSource(REGISTRY, read, log, {
      pickStartPage: () => lastPage,
    });

    await source.getOwners();

    expect(MAX_TRUSTED_OWNER_COUNT).toBe(10_000_000);
    expect(offsets[0]).toBe(1_000_000n);
    expect(errorReasons).toHaveLength(1);
    expect(errorReasons[0]).toContain(`lists ${reported} owners`);
  });

  it('reports the raw on-chain count past the bound and says the owners after it are not read', async () => {
    const reported = BigInt(MAX_TRUSTED_OWNER_COUNT) + 12_345n;
    const { log, errorReasons } = createStubLogger();
    const read: KeeperReadClient = {
      readContract: async ({ functionName }) => (functionName === 'vaultOwnerCount' ? reported : []),
    };
    const source = createRegistryVaultOwnerSource(REGISTRY, read, log, FROM_HEAD);

    await source.getOwners();

    const [bound, window] = errorReasons;
    expect(errorReasons).toHaveLength(2);
    expect(bound).toContain(`reports ${reported} owners`);
    expect(bound).toContain(`owners listed after the first ${MAX_TRUSTED_OWNER_COUNT} are not read`);
    expect(bound).toMatch(/count may be real/i);
    expect(bound).not.toContain('no real registry');
    expect(bound).not.toContain('cannot be real');
    expect(window).toContain(`the registry lists ${reported} owners`);
    expect(window).toContain(
      `each of the first ${MAX_TRUSTED_OWNER_COUNT} owners is read at least once every`
    );
    expect(window).toContain(`owners listed after the first ${MAX_TRUSTED_OWNER_COUNT} are not read`);
  });

  /** The bound and window errors a count raises, from a registry whose pages are all empty. */
  const reasonsFor = async (reported: bigint): Promise<string[]> => {
    const { log, errorReasons } = createStubLogger();
    const read: KeeperReadClient = {
      readContract: async ({ functionName }) => (functionName === 'vaultOwnerCount' ? reported : []),
    };
    await createRegistryVaultOwnerSource(REGISTRY, read, log, FROM_HEAD).getOwners();
    return errorReasons;
  };

  /** The bound error a count raises, from a registry whose pages are all empty. */
  const boundReason = async (reported: bigint): Promise<string | undefined> =>
    (await reasonsFor(reported))[0];

  // A count of 2^256 - 1 was told it "may be real". Each
  // listed owner costs a storage write, so no chain could ever hold 2^64 of them.
  it('says a count of 2^64 or more cannot be real and that the RPC is wrong', async () => {
    for (const reported of [2n ** 64n, 2n ** 256n - 1n]) {
      const bound = await boundReason(reported);
      expect(bound).toContain(`reports ${reported} owners`);
      expect(bound).toContain('cannot be real');
      expect(bound).toContain('RPC is wrong');
      expect(bound).not.toMatch(/may be real/i);
    }
  });

  it('keeps the may-be-real wording for a count past the bound but below 2^64', async () => {
    const bound = await boundReason(2n ** 64n - 1n);
    expect(bound).toMatch(/count may be real/i);
    expect(bound).not.toContain('cannot be real');
    expect(bound).not.toContain('RPC is wrong');
  });

  // After the bound error said a count of 2^64 or more
  // cannot be real, the window error still said "the registry lists" that many owners.
  it('attributes a count of 2^64 or more to the RPC in the window error too', async () => {
    for (const reported of [2n ** 64n, 2n ** 256n - 1n]) {
      const [, window] = await reasonsFor(reported);
      expect(window).toContain(`the RPC reports ${reported} owners`);
      expect(window).not.toContain('the registry lists');
    }
    const [, possible] = await reasonsFor(2n ** 64n - 1n);
    expect(possible).toContain(`the registry lists ${2n ** 64n - 1n} owners`);
  });
});

// A window cursor that starts at the head on
// every process start lets a keeper in a restart loop reread the same window for ever. It
// also sets a primary and a secondary keeper rotating in lockstep over the same pages.
describe('createRegistryVaultOwnerSource window start', () => {
  const totalOwners = MAX_REGISTRY_OWNERS * 2 + REGISTRY_OWNER_PAGE * 3 + 7;
  const owners = Array.from({ length: totalOwners }, (_, i) => ownerAt(i));
  const totalPages = Math.ceil(totalOwners / REGISTRY_OWNER_PAGE);
  const pagesPerTick = MAX_REGISTRY_OWNERS / REGISTRY_OWNER_PAGE;

  const firstWindow = async (pickStartPage?: (pageCount: number) => number): Promise<number[]> => {
    const calls: KeeperContractCall[] = [];
    const source = createRegistryVaultOwnerSource(
      REGISTRY,
      createRegistryRead(owners, calls),
      createStubLogger().log,
      pickStartPage === undefined ? {} : { pickStartPage }
    );
    await source.getOwners();
    return pageOffsets(calls);
  };

  it('asks for the start page with the page count and two different draws read different first windows', async () => {
    const asked: number[] = [];
    const primary = await firstWindow((pageCount) => {
      asked.push(pageCount);
      return 0;
    });
    const secondary = await firstWindow(() => pagesPerTick);

    expect(asked).toEqual([totalPages]);
    expect(primary[0]).toBe(0);
    expect(secondary[0]).toBe(pagesPerTick * REGISTRY_OWNER_PAGE);
    expect(primary.filter((offset) => secondary.includes(offset))).toEqual([]);
  });

  it('wraps from a start near the tail and still covers every page within ceil(count / window) ticks', async () => {
    const calls: KeeperContractCall[] = [];
    const startPage = totalPages - 3;
    const source = createRegistryVaultOwnerSource(
      REGISTRY,
      createRegistryRead(owners, calls),
      createStubLogger().log,
      { pickStartPage: () => startPage }
    );
    const seen = new Set<Address>();
    const offsetsRead = new Set<number>();

    for (let tick = 0; tick < Math.ceil(totalOwners / MAX_REGISTRY_OWNERS); tick++) {
      calls.length = 0;
      (await source.getOwners()).forEach((owner) => seen.add(owner));
      const offsets = pageOffsets(calls);
      offsets.forEach((offset) => offsetsRead.add(offset));
      if (tick === 0) {
        // The window runs off the tail and carries on from the head in the same tick.
        expect(offsets.slice(0, 4)).toEqual([
          startPage * REGISTRY_OWNER_PAGE,
          (startPage + 1) * REGISTRY_OWNER_PAGE,
          (startPage + 2) * REGISTRY_OWNER_PAGE,
          0,
        ]);
      }
    }

    expect(offsetsRead.size).toBe(totalPages);
    expect(seen.size).toBe(totalOwners);
  });

  // Freezing Date.now alone let a seed from process.hrtime or any other clock pass. The
  // spy shows the default asks node:crypto randomInt for a page below the page count and
  // starts the first window on exactly the page it returned.
  it('draws the default start from node:crypto randomInt over the page count and starts there', async () => {
    const drawn = pagesPerTick + 5;
    mockRandomInt.mockClear();
    mockRandomInt.mockReturnValueOnce(drawn);

    const offsets = await firstWindow();

    expect(mockRandomInt).toHaveBeenCalledTimes(1);
    expect(mockRandomInt).toHaveBeenCalledWith(totalPages);
    expect(offsets[0]).toBe(drawn * REGISTRY_OWNER_PAGE);
  });

  it('starts every default window on a page boundary inside the listing', async () => {
    const starts = new Set<number>();
    for (let draw = 0; draw < 16; draw++) starts.add((await firstWindow())[0]);
    // Sixteen draws over 84 pages all landing on one page has odds near 84^-15.
    expect(starts.size).toBeGreaterThan(1);
    for (const start of starts) {
      expect(start % REGISTRY_OWNER_PAGE).toBe(0);
      expect(start).toBeLessThan(totalOwners);
    }
  });

  it('keeps reading from the head while the registry fits one window, whatever the draw', async () => {
    const calls: KeeperContractCall[] = [];
    const small = owners.slice(0, MAX_REGISTRY_OWNERS);
    const source = createRegistryVaultOwnerSource(
      REGISTRY,
      createRegistryRead(small, calls),
      createStubLogger().log,
      { pickStartPage: () => 7 }
    );

    await expect(source.getOwners()).resolves.toEqual(small);
  });
});

// The union must know whether the registry read failed,
// so the registry source says so with each read. A failed count, or a window in which every
// page failed, reads no list at all; one page lost out of several still reads a list.
describe('createRegistryVaultOwnerSource readings', () => {
  const readingOf = async (read: KeeperReadClient): Promise<OwnerSourceReading> =>
    createRegistryVaultOwnerSource(REGISTRY, read, createStubLogger().log).readOwners();

  it('reports a failed count as a failed read', async () => {
    const reading = await readingOf({
      readContract: async () => {
        throw new Error('rpc down');
      },
    });
    expect(reading).toEqual({ label: 'the VaultRegistry', owners: [], failed: true, truncated: false });
  });

  it('reports a window in which every page failed as a failed read', async () => {
    const reading = await readingOf({
      readContract: async (call) => {
        if (call.functionName === 'vaultOwnerCount') return BigInt(REGISTRY_OWNER_PAGE * 2);
        throw new Error('rpc down');
      },
    });
    expect(reading.failed).toBe(true);
    expect(reading.owners).toEqual([]);
  });

  // A window that lost every page but one was reported
  // as a full read, so a union beside no other full list said nothing.
  it('reports a read that kept some pages as truncated, not failed', async () => {
    const owners = Array.from({ length: REGISTRY_OWNER_PAGE * 3 }, (_, i) => ownerAt(i));
    const partial = await readingOf({
      readContract: async (call) => {
        if (call.functionName === 'vaultOwnerCount') return BigInt(owners.length);
        const [offset] = call.args as readonly [bigint, bigint];
        if (offset > 0n) throw new Error('rpc blip');
        return owners.slice(0, REGISTRY_OWNER_PAGE);
      },
    });
    expect(partial).toMatchObject({ failed: false, truncated: true });
    expect(partial.owners).toHaveLength(REGISTRY_OWNER_PAGE);
  });

  it('reports a window in which every page was read as a full read', async () => {
    const owners = Array.from({ length: REGISTRY_OWNER_PAGE + 1 }, (_, i) => ownerAt(i));
    const reading = await readingOf(createRegistryRead(owners, []));
    expect(reading).toEqual({ label: 'the VaultRegistry', owners, failed: false, truncated: false });
  });

  it('reports an empty registry as a full read', async () => {
    const empty = await readingOf(createRegistryRead([], []));
    expect(empty).toEqual({ label: 'the VaultRegistry', owners: [], failed: false, truncated: false });
  });

  it('returns the same owners through getOwners as through readOwners', async () => {
    const owners = Array.from({ length: 3 }, (_, i) => ownerAt(i));
    const source = createRegistryVaultOwnerSource(
      REGISTRY,
      createRegistryRead(owners, []),
      createStubLogger().log
    );
    await expect(source.getOwners()).resolves.toEqual(owners);
    await expect(source.readOwners()).resolves.toMatchObject({ owners });
  });
});

describe('combineVaultOwnerSources', () => {
  /** A source that reports a fixed reading on every read. */
  const reporting = (reading: OwnerSourceReading) => ({
    getOwners: async () => reading.owners,
    readOwners: async () => reading,
  });
  const registry = (failed: boolean, owners: Address[] = []) =>
    reporting({ label: 'the VaultRegistry', owners, failed, truncated: false });
  const indexerSet = (owners: Address[], truncated: boolean) =>
    reporting({ label: "the indexer's owner set", owners, failed: false, truncated });
  /** A registry walk that lost some pages of its window and kept the others. */
  const partialRegistry = (owners: Address[]) =>
    reporting({ label: 'the VaultRegistry', owners, failed: false, truncated: true });
  const failedIndexerSet = () =>
    reporting({ label: "the indexer's owner set", owners: [], failed: true, truncated: false });

  it('unions the sources and drops duplicates regardless of casing', async () => {
    const a = ownerAt(0);
    const b = ownerAt(1);
    const c = ownerAt(2);
    const combined = combineVaultOwnerSources(
      [
        { getOwners: async () => [a, b] },
        { getOwners: async () => [b.toLowerCase() as Address, c] },
      ],
      createStubLogger().log
    );
    await expect(combined.getOwners()).resolves.toEqual([a, b, c]);
  });

  it('keeps the other sources when one returns nothing', async () => {
    const a = ownerAt(0);
    const combined = combineVaultOwnerSources(
      [{ getOwners: async () => [] }, { getOwners: async () => [a] }],
      createStubLogger().log
    );
    await expect(combined.getOwners()).resolves.toEqual([a]);
  });

  // A keeper with VAULT_REGISTRY_ADDRESS set whose
  // registry read fails sweeps only the indexer's set. When that set is truncated each
  // source logged at warn, so nothing paged although the truncated set was the only list.
  it('pages when the registry read failed and the only list read is truncated', async () => {
    const a = ownerAt(0);
    const { log, warns, errors, errorReasons } = createStubLogger();
    const combined = combineVaultOwnerSources([registry(true), indexerSet([a], true)], log);

    await expect(combined.getOwners()).resolves.toEqual([a]);

    expect(warns).toEqual([]);
    expect(errors).toEqual(['keeper.job-error:vault-owner-sources']);
    expect(errorReasons[0]).toContain('no full owner list was read this tick');
    expect(errorReasons[0]).toContain('reading the VaultRegistry failed');
    expect(errorReasons[0]).toContain("the indexer's owner set returned a truncated list");
    expect(errorReasons[0]).toContain('not watched for liquidation');
  });

  it('adds nothing to a truncated list while the registry read succeeds', async () => {
    const a = ownerAt(0);
    const b = ownerAt(1);
    const { log, warns, errors } = createStubLogger();
    const combined = combineVaultOwnerSources([registry(false, [b]), indexerSet([a], true)], log);

    await expect(combined.getOwners()).resolves.toEqual([b, a]);
    expect([...warns, ...errors]).toEqual([]);
  });

  it('does not page a failed registry read while the other list is complete', async () => {
    const a = ownerAt(0);
    const { log, errors } = createStubLogger();
    const combined = combineVaultOwnerSources([registry(true), indexerSet([a], false)], log);

    await expect(combined.getOwners()).resolves.toEqual([a]);
    expect(errors).toEqual([]);
  });

  it('counts a source that cannot report as a full list', async () => {
    const a = ownerAt(0);
    const { log, errors } = createStubLogger();
    const combined = combineVaultOwnerSources(
      [registry(true), indexerSet([a], true), { getOwners: async () => [ownerAt(1)] }],
      log
    );

    await expect(combined.getOwners()).resolves.toEqual([a, ownerAt(1)]);
    expect(errors).toEqual([]);
  });

  // A tick on which every source failed left the keeper
  // with no owners, and the liquidation watch then logged vault.no-owners at info as an
  // honest pre-launch state, so a persistent registry fault left every vault unwatched.
  describe('on a tick that read no owner list at all', () => {
    it('pages when the registry read and the indexer set both fail', async () => {
      const { log, warns, errors, errorReasons } = createStubLogger();
      const combined = combineVaultOwnerSources([registry(true), failedIndexerSet()], log);

      await expect(combined.getOwners()).resolves.toEqual([]);

      expect(warns).toEqual([]);
      expect(errors).toEqual(['keeper.job-error:vault-owner-sources']);
      expect(errorReasons[0]).toBe(
        "no owner list was read this tick: reading the VaultRegistry and the indexer's owner set failed, so no open vault is watched for liquidation until an owner list is read again"
      );
    });

    it('pages a single source whose read failed, the registry-only keeper', async () => {
      const { log, errors, errorReasons } = createStubLogger();
      const combined = combineVaultOwnerSources([registry(true)], log);

      await expect(combined.getOwners()).resolves.toEqual([]);

      expect(errors).toEqual(['keeper.job-error:vault-owner-sources']);
      expect(errorReasons[0]).toContain('reading the VaultRegistry failed');
      expect(errorReasons[0]).toContain('no open vault is watched for liquidation');
    });

    it('says nothing about an empty list that was read, the state before launch', async () => {
      const { log, warns, errors } = createStubLogger();
      const combined = combineVaultOwnerSources([registry(false, [])], log);

      await expect(combined.getOwners()).resolves.toEqual([]);
      expect([...warns, ...errors]).toEqual([]);
    });

    // parseKeeperConfig refuses a keeper with no owner source; a union of none judges nothing.
    it('says nothing for a union of no sources', async () => {
      const { log, warns, errors } = createStubLogger();
      await expect(combineVaultOwnerSources([], log).getOwners()).resolves.toEqual([]);
      expect([...warns, ...errors]).toEqual([]);
    });

    it('does not page a failed read beside an empty list that was read', async () => {
      const { log, errors } = createStubLogger();
      const combined = combineVaultOwnerSources([registry(false, []), failedIndexerSet()], log);

      await expect(combined.getOwners()).resolves.toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  describe('beside a registry walk that lost some of its pages', () => {
    it('pages the registry alone, since no full list was read', async () => {
      const a = ownerAt(0);
      const { log, errors, errorReasons } = createStubLogger();
      const combined = combineVaultOwnerSources([partialRegistry([a])], log);

      await expect(combined.getOwners()).resolves.toEqual([a]);

      expect(errors).toEqual(['keeper.job-error:vault-owner-sources']);
      expect(errorReasons[0]).toBe(
        'no full owner list was read this tick: the VaultRegistry returned a truncated list, so open vaults missing from that list are not watched for liquidation until a full list is read again'
      );
    });

    it('pages when the indexer set beside it is truncated too', async () => {
      const a = ownerAt(0);
      const b = ownerAt(1);
      const { log, errors, errorReasons } = createStubLogger();
      const combined = combineVaultOwnerSources([partialRegistry([a]), indexerSet([b], true)], log);

      await expect(combined.getOwners()).resolves.toEqual([a, b]);

      expect(errors).toEqual(['keeper.job-error:vault-owner-sources']);
      expect(errorReasons[0]).toBe(
        "no full owner list was read this tick: the VaultRegistry and the indexer's owner set each returned a truncated list, so open vaults missing from all of them are not watched for liquidation until a full list is read again"
      );
    });

    it('pages when the indexer set beside it failed', async () => {
      const a = ownerAt(0);
      const { log, errors, errorReasons } = createStubLogger();
      const combined = combineVaultOwnerSources([partialRegistry([a]), failedIndexerSet()], log);

      await expect(combined.getOwners()).resolves.toEqual([a]);

      expect(errors).toEqual(['keeper.job-error:vault-owner-sources']);
      expect(errorReasons[0]).toContain(
        "reading the indexer's owner set failed and the VaultRegistry returned a truncated list"
      );
    });

    it('stays quiet beside a complete indexer set', async () => {
      const a = ownerAt(0);
      const b = ownerAt(1);
      const { log, warns, errors } = createStubLogger();
      const combined = combineVaultOwnerSources([partialRegistry([a]), indexerSet([b], false)], log);

      await expect(combined.getOwners()).resolves.toEqual([a, b]);
      expect([...warns, ...errors]).toEqual([]);
    });
  });
});
