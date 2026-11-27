import { randomInt } from 'node:crypto';
import { getAddress, isAddress, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { vaultRegistryKeeperAbi } from './abis';
import { KEEPER_EVENTS } from './alerts';
import { describeError } from './decode';
import type { KeeperLogger, KeeperReadClient, VaultOwnerSource } from './ports';

// Kept apart from ownerSource.ts on purpose: that file imports the Redis cache
// manager, so nothing here may pull Redis into a unit test through it. This file
// touches only the read client.
/** Owners per registry page; one eth_call each, far below any RPC response cap. */
export const REGISTRY_OWNER_PAGE = 500;

/**
 * Most owners read per tick: a bound on the work of one tick, never on which owners are
 * read. A registry longer than this is walked as a rotating window that resumes where
 * the previous tick stopped, so while the listing is unchanged every listed owner is read
 * within ceil(count / MAX_REGISTRY_OWNERS) ticks. A removal moves the last owner into the
 * freed slot (EnumerableSet swap and pop), which can delay that owner by up to one more
 * rotation when the window has already passed the slot. Membership costs one wei of
 * collateral, so a fixed head of the listing let dust owners hide every vault listed after
 * them.
 */
export const MAX_REGISTRY_OWNERS = 20_000;

/**
 * Most owners the walk ever covers. A compromised RPC answering vaultOwnerCount with
 * 2^256-1 is clamped here, and each tick still reads at most MAX_REGISTRY_OWNERS owners, so it
 * cannot pin the keeper in a page loop. A count past the bound may still be real:
 * membership costs one wei of collateral, so dust deposits can list this many owners.
 * Owners listed after the bound are never read, and every tick that meets such a count
 * reports the count the chain gave at error level. From IMPOSSIBLE_OWNER_COUNT upwards
 * that report says the count cannot be real and blames the RPC instead.
 */
export const MAX_TRUSTED_OWNER_COUNT = 10_000_000;

/**
 * The smallest owner count no chain could hold. Listing an owner writes at least one fresh
 * storage slot, 20,000 gas or more, so 2^64 owners would take over 3.6 * 10^23 gas: millions
 * of years of full blocks on any chain. A count this large is not dust; the RPC is wrong.
 */
export const IMPOSSIBLE_OWNER_COUNT = 2n ** 64n;

const PAGES_PER_TICK = MAX_REGISTRY_OWNERS / REGISTRY_OWNER_PAGE;

const JOB = 'vault-registry-owner-source';
const UNION_JOB = 'vault-owner-sources';

/**
 * One tick's read of an owner source, for a union that judges its sources together.
 * `failed` is true when the source read no list at all this tick, and `truncated` when the
 * list it read is known to lack open vaults: a registry walk that lost some of its pages,
 * or an indexer set capped at its limit. A reading with neither is a full list, an empty
 * one included. `label` names the source in a log line.
 */
export interface OwnerSourceReading {
  readonly label: string;
  readonly owners: Address[];
  readonly failed: boolean;
  readonly truncated: boolean;
}

/** An owner source that also says how each read went, so a union can judge it. */
export interface ReportingVaultOwnerSource extends VaultOwnerSource {
  readOwners(): Promise<OwnerSourceReading>;
}

export interface RegistryOwnerSourceOptions {
  /**
   * Chooses the page the first window starts from, given the page count, once the
   * registry is longer than one window. The default is a uniform draw from node:crypto,
   * so a keeper in a restart loop does not reread the head window and a primary and a
   * secondary keeper do not rotate over the same pages in lockstep. The wall clock would
   * give two keepers started together the same page. Tests pass a fixed choice.
   */
  readonly pickStartPage?: (pageCount: number) => number;
}

const randomStartPage = (pageCount: number): number => randomInt(pageCount);

/** A page index inside [0, totalPages), whatever the stored or chosen page was. */
const wrapPage = (page: number, totalPages: number): number =>
  Number.isSafeInteger(page) ? ((page % totalPages) + totalPages) % totalPages : 0;

/** The owner count as the registry reported it and the part of it the walk covers. */
interface OwnerCount {
  readonly reported: bigint;
  readonly walked: number;
}

const readOwnerCount = (raw: unknown, log: KeeperLogger): OwnerCount => {
  if (typeof raw !== 'bigint' || raw < 0n) {
    throw new Error('vaultOwnerCount returned a non-integer');
  }
  if (raw <= BigInt(MAX_TRUSTED_OWNER_COUNT)) return { reported: raw, walked: Number(raw) };
  const unread = `past the bound of ${MAX_TRUSTED_OWNER_COUNT} this keeper walks: owners listed after the first ${MAX_TRUSTED_OWNER_COUNT} are not read, so they are not watched for liquidation`;
  const verdict =
    raw >= IMPOSSIBLE_OWNER_COUNT
      ? `No chain could hold that many owners, since each one listed costs a storage write, so the count cannot be real and this RPC is wrong; point the keeper at another RPC`
      : `The count may be real, since dust deposits of one wei can list this many owners; compare it with a second RPC before treating this one as wrong`;
  log.error(KEEPER_EVENTS.jobError, {
    job: JOB,
    reason: `vaultOwnerCount reports ${raw.toString()} owners, ${unread}. ${verdict}`,
  });
  return { reported: raw, walked: MAX_TRUSTED_OWNER_COUNT };
};

/**
 * The error a tick reports while the registry is longer than one window. A window that
 * meets a short last page or runs off the tail reads fewer than MAX_REGISTRY_OWNERS, and
 * one that wraps rereads some pages within a rotation, so the message gives the most read
 * and the longest gap between two reads of an owner while the listing is unchanged, never
 * an exact figure. A count no chain could hold is given as the RPC's word, not as fact.
 */
const windowReason = (count: OwnerCount, firstPage: number, totalPages: number): string => {
  const ticks = Math.ceil(totalPages / PAGES_PER_TICK);
  const cadence =
    BigInt(count.walked) < count.reported
      ? `each of the first ${MAX_TRUSTED_OWNER_COUNT} owners is read at least once every ${ticks} ticks while the listing is unchanged, and owners listed after the first ${MAX_TRUSTED_OWNER_COUNT} are not read`
      : `each owner is read at least once every ${ticks} ticks while the listing is unchanged`;
  const wraps = firstPage + PAGES_PER_TICK > totalPages ? ', wrapping to the head of the listing' : '';
  const listed =
    count.reported >= IMPOSSIBLE_OWNER_COUNT
      ? `the RPC reports ${count.reported.toString()} owners`
      : `the registry lists ${count.reported.toString()} owners`;
  return `${listed}, more than the ${MAX_REGISTRY_OWNERS} read per tick; reading up to ${MAX_REGISTRY_OWNERS} from offset ${firstPage * REGISTRY_OWNER_PAGE}${wraps}, so ${cadence}; a removal moves the last owner into the freed slot, which can delay that owner by up to one more rotation`;
};

/** The pages one tick reads: all of them, or a window that wraps round the listing. */
const windowOffsets = (firstPage: number, pageCount: number, totalPages: number): number[] =>
  Array.from(
    { length: pageCount },
    (_, index) => ((firstPage + index) % totalPages) * REGISTRY_OWNER_PAGE
  );

/**
 * Keeps the genuine owners of a page: strings that parse as addresses, never the
 * zero address, and never more entries than were asked for. A hostile RPC can
 * answer a 500-owner request with a page of any length; it gets 500 at most.
 */
const ownersOf = (page: unknown): Address[] => {
  if (!Array.isArray(page)) {
    throw new Error('vaultOwners returned a non-array page');
  }
  return page
    .slice(0, REGISTRY_OWNER_PAGE)
    .filter((entry): entry is string => typeof entry === 'string' && isAddress(entry))
    .map((entry) => getAddress(entry))
    .filter((owner) => owner !== zeroAddress);
};

/**
 * VaultOwnerSource backed by the on-chain VaultRegistry (vaultOwnerCount plus
 * vaultOwners pages). The registry is maintained by GoldVault itself, so this
 * list is exactly the set of open vaults with no indexer in the loop. A failed
 * count degrades to an empty list with a warn, like the Redis source. The pages
 * are fetched together, since their number is known from the count and bounded
 * by the window, so a slow RPC costs one round trip rather than one per page and
 * cannot stretch the tick that the breaker and price checks share; a page that
 * fails is dropped with a warn and the others are kept, so one bad page never
 * empties the walk. Its reading counts as failed when the count failed or every
 * page of the window did, since the tick then read no registry list at all, and
 * as truncated when some pages of the window failed and the others were read.
 *
 * A registry longer than MAX_REGISTRY_OWNERS is read one window per tick. The source
 * keeps the page the next tick starts from, so the window rotates through the whole
 * listing rather than rereading its head. The first window starts at a page drawn at
 * random once the page count is known, so restarts and a pair of keepers cover different
 * windows. Every such tick is reported at error so an operator sees that each vault is
 * now read only every few ticks.
 */
export const createRegistryVaultOwnerSource = (
  registry: Address,
  read: KeeperReadClient,
  log: KeeperLogger,
  options: RegistryOwnerSourceOptions = {}
): ReportingVaultOwnerSource => {
  const pickStartPage = options.pickStartPage ?? randomStartPage;
  // The one piece of state the source keeps between ticks: where the next window starts.
  // It stays unset until the registry first outgrows one window.
  let nextPage: number | undefined;
  const reading = (owners: Address[], failed: boolean, truncated: boolean): OwnerSourceReading => ({
    label: 'the VaultRegistry',
    owners,
    failed,
    truncated,
  });
  const readOwners = async (): Promise<OwnerSourceReading> => {
    const warn = (reason: string): void => log.warn(KEEPER_EVENTS.jobError, { job: JOB, reason });
    let count: OwnerCount;
    try {
      count = readOwnerCount(
        await read.readContract({
          address: registry,
          abi: vaultRegistryKeeperAbi,
          functionName: 'vaultOwnerCount',
        }),
        log
      );
    } catch (error) {
      warn(describeError(error));
      return reading([], true, false);
    }
    const totalPages = Math.ceil(count.walked / REGISTRY_OWNER_PAGE);
    const overWindow = totalPages > PAGES_PER_TICK;
    // The registry may have shrunk since the last tick, so the stored start wraps.
    const firstPage = overWindow ? wrapPage(nextPage ?? pickStartPage(totalPages), totalPages) : 0;
    const offsets = windowOffsets(firstPage, Math.min(totalPages, PAGES_PER_TICK), totalPages);
    if (overWindow) {
      nextPage = (firstPage + PAGES_PER_TICK) % totalPages;
      log.error(KEEPER_EVENTS.jobError, {
        job: JOB,
        reason: windowReason(count, firstPage, totalPages),
      });
    }
    const pages = await Promise.allSettled(
      offsets.map((offset) =>
        read
          .readContract({
            address: registry,
            abi: vaultRegistryKeeperAbi,
            functionName: 'vaultOwners',
            args: [BigInt(offset), BigInt(REGISTRY_OWNER_PAGE)],
          })
          .then(ownersOf)
      )
    );
    const owners = pages
      .flatMap((page) => (page.status === 'fulfilled' ? page.value : []))
      .slice(0, MAX_REGISTRY_OWNERS);
    pages.forEach((page, index) => {
      if (page.status === 'rejected') {
        warn(`page at offset ${offsets[index]} failed, keeping ${owners.length} owners from the other pages: ${describeError(page.reason)}`);
      }
    });
    const failedPages = pages.filter((page) => page.status === 'rejected').length;
    const everyPageFailed = failedPages > 0 && failedPages === pages.length;
    return reading(owners, everyPageFailed, failedPages > 0 && !everyPageFailed);
  };
  return {
    readOwners,
    getOwners: async (): Promise<Address[]> => (await readOwners()).owners,
  };
};

/** What the union reads: any owner source, asked how its read went when it can say. */
type UnionMember = VaultOwnerSource & Partial<Pick<ReportingVaultOwnerSource, 'readOwners'>>;

/** A source that cannot report is taken at its word: a full list, read without failing. */
const readingOf = (source: UnionMember): Promise<OwnerSourceReading> =>
  source.readOwners?.() ??
  source.getOwners().then((owners) => ({ label: 'an owner source', owners, failed: false, truncated: false }));

const named = (list: readonly OwnerSourceReading[]): string =>
  list.map((reading) => reading.label).join(' and ');

/** Why a tick on which no source read a full list is paged; every reading failed or is truncated. */
const missingListReason = (readings: readonly OwnerSourceReading[]): string => {
  const failed = readings.filter((reading) => reading.failed);
  const truncated = readings.filter((reading) => !reading.failed && reading.truncated);
  if (truncated.length === 0) {
    return `no owner list was read this tick: reading ${named(failed)} failed, so no open vault is watched for liquidation until an owner list is read again`;
  }
  const failures = failed.length === 0 ? '' : `reading ${named(failed)} failed and `;
  const kept =
    truncated.length === 1
      ? `${named(truncated)} returned a truncated list, so open vaults missing from that list`
      : `${named(truncated)} each returned a truncated list, so open vaults missing from all of them`;
  return `no full owner list was read this tick: ${failures}${kept} are not watched for liquidation until a full list is read again`;
};

/**
 * Pages every tick on which no source read a full list, since the keeper then sweeps a
 * partial list or none and the open vaults missing from it go unwatched. That is every
 * source failing (the registry address with no code among them) or what was read being
 * truncated: a registry walk that lost pages or a capped indexer set, with no full list
 * beside it. Each source logs its own failure or truncation at warn when read here, so this
 * is the one page for the tick. A full list, an empty registry before launch included, keeps
 * the tick quiet whatever the other sources report.
 */
const reportMissingOwnerList = (readings: readonly OwnerSourceReading[], log: KeeperLogger): void => {
  const fullListRead = readings.some((reading) => !reading.failed && !reading.truncated);
  if (fullListRead || readings.length === 0) return;
  log.error(KEEPER_EVENTS.jobError, { job: UNION_JOB, reason: missingListReason(readings) });
};

/**
 * Union of owner sources, deduplicated by checksummed address. Each source
 * already degrades to an empty list on failure, so one broken source narrows
 * the walk to what the others know rather than stopping it. The keeper reads
 * even a single source through it, so a tick on which no full list was read is
 * paged whatever the configuration (see reportMissingOwnerList).
 */
export const combineVaultOwnerSources = (
  sources: readonly UnionMember[],
  log: KeeperLogger
): VaultOwnerSource => ({
  getOwners: async (): Promise<Address[]> => {
    const readings = await Promise.all(sources.map(readingOf));
    reportMissingOwnerList(readings, log);
    const seen = new Set<Address>();
    return readings.flatMap((reading) => reading.owners).filter((owner) => {
      const key = getAddress(owner);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
});
