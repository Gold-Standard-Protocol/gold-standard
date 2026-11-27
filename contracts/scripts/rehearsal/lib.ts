/**
 * Shared tooling for the mainnet-fork rehearsal (docs/MAINNET.md section 2, plan section 6 blocker 4).
 *
 * Every transaction goes through a raw ethers provider pointed at the fork node (LOCAL_RPC_URL,
 * --network localhost), so the rehearsal can act as whales, Safes and Chainlink's proxy owner by
 * impersonation and as deterministic throwaway wallets alike. The provider buffers every gas
 * estimate by 1.3x, as `gasMultiplier` does for Hardhat's signers (see
 * scripts/lib/bufferedWallet.ts for why an exact estimate fails on a fork).
 *
 * Fork only: refuses any network but localhost, and `assertFork` refuses any node that does not
 * report itself as a Hardhat node presenting chain id 31337. Never run against --network mainnet:
 * that network is the real chain and its snapshot paths belong to the real launch.
 */
import { artifacts, network } from "hardhat";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Contract,
  ContractFactory,
  Interface,
  JsonRpcProvider,
  JsonRpcSigner,
  Wallet,
  ZeroHash,
  formatUnits,
  id,
  keccak256,
  solidityPackedKeccak256,
  toUtf8Bytes,
} from "ethers";
import type { ContractTransactionResponse, Signer, TransactionReceipt, TransactionRequest, TransactionResponse } from "ethers";
import { describeErrorStack, redactUrls } from "../lib/redact";

export const ADDR = {
  PAXG: "0x45804880De22913dAFE09f4980848ECE6EcbAf78",
  XAUT: "0x68749665FF8D2d112Fa859AA293F07A622782F38",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  PAXG_USD: "0x9944D86CEB9160aF5C5feB251FD671923323f8C3",
  XAU_USD: "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6",
  ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  POOL: "0x8a7e585048bda875e64024118c506b14f78166dd",
  ROUTER: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  PAXG_HOLDER: "0x5a52E96BAcdaBb82fd05763E25335261B270Efcb",
  XAUT_HOLDER: "0x5754284f345afc66a98fbB0a0Afe71e0F007B949",
} as const;

export const E18 = 10n ** 18n;
export const E8 = 10n ** 8n;
export const PPM = 1_000_000n;
export const MAX = (1n << 256n) - 1n;
export const YEAR_SECONDS = 365 * 86_400;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function deposit() payable",
];
const PROXY_ABI = [
  "function aggregator() view returns (address)",
  "function owner() view returns (address)",
  "function proposeAggregator(address)",
  "function confirmAggregator(address)",
  "function phaseId() view returns (uint16)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function observations(uint256) view returns (uint32,int56,uint160,bool)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

/** A raw provider whose gas estimates carry the same 1.3x buffer as Hardhat's localhost signers. */
class BufferedProvider extends JsonRpcProvider {
  override async estimateGas(tx: TransactionRequest): Promise<bigint> {
    const estimate = ((await super.estimateGas(tx)) * 13n) / 10n;
    // Fusaka caps one transaction at 2^24 gas; the fork node runs with that block limit.
    return estimate > 16_700_000n ? 16_700_000n : estimate;
  }
}

export function rpcUrl(): string {
  if (network.name !== "localhost") throw new Error(`Refusing network "${network.name}": the rehearsal runs only with --network localhost and LOCAL_RPC_URL at the fork`);
  const url = (network.config as { url?: string }).url;
  if (!url) throw new Error("localhost has no url; set LOCAL_RPC_URL=http://127.0.0.1:8547");
  return url;
}

export const provider = new BufferedProvider(rpcUrl(), undefined, { staticNetwork: true, pollingInterval: 100, batchMaxCount: 1, cacheTimeout: -1 });

export const send = (method: string, params: unknown[] = []): Promise<any> => provider.send(method, params);

/** Refuses anything but a local Hardhat node: nothing in the rehearsal may reach a real network. */
export async function assertFork(): Promise<{ chainId: bigint; block: number; client: string }> {
  const client: string = await send("web3_clientVersion");
  if (!/hardhat/i.test(client)) throw new Error(`Refusing to run: ${rpcUrl()} reports "${client}", not a Hardhat fork node`);
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 31337n) throw new Error(`Unexpected chain id ${chainId}; the fork node must present 31337`);
  const code = await provider.getCode(ADDR.PAXG);
  if (code === "0x") throw new Error("PAXG has no code: this node is not a fork of mainnet");
  return { chainId, block: await provider.getBlockNumber(), client };
}

// ---------------------------------------------------------------- time and snapshots

export async function latestTs(): Promise<number> {
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("no latest block");
  return block.timestamp;
}

export async function advance(seconds: number): Promise<void> {
  await send("evm_increaseTime", [seconds]);
  await send("evm_mine");
}

export const snapshot = (): Promise<string> => send("evm_snapshot");
export async function revertTo(id: string): Promise<void> {
  const ok = await send("evm_revert", [id]);
  if (!ok) throw new Error(`evm_revert(${id}) failed`);
}

/** Revert to a snapshot and take it again: Hardhat consumes a snapshot on revert. */
export async function rewind(id: string): Promise<string> {
  await revertTo(id);
  return snapshot();
}

// ---------------------------------------------------------------- accounts

/** A deterministic throwaway wallet per label, funded with ETH on the fork. Fork-only keys. */
export async function wallet(label: string, eth = 1_000n): Promise<Wallet> {
  const w = new Wallet(keccak256(toUtf8Bytes(`gsusd-mainnet-fork-rehearsal:${label}`)), provider);
  await setEth(w.address, eth * E18);
  return w;
}

export async function setEth(address: string, wei: bigint): Promise<void> {
  await send("hardhat_setBalance", [address, "0x" + wei.toString(16)]);
}

/** Impersonate any address (a whale, a Safe, the feeds' owner) and return a signer for it. */
export async function impersonate(address: string): Promise<JsonRpcSigner> {
  await send("hardhat_impersonateAccount", [address]);
  if ((await provider.getBalance(address)) < 10n * E18) await setEth(address, 100n * E18);
  return new JsonRpcSigner(provider, address);
}

// ---------------------------------------------------------------- contracts

/**
 * Artifacts by contract name. REHEARSAL_ARTIFACTS names a frozen copy of contracts/artifacts, so a
 * compile running elsewhere in the repository mid-rehearsal cannot change or remove an ABI under us.
 */
let frozenIndex: Map<string, string> | undefined;
async function readArtifact(name: string): Promise<{ abi: unknown[]; bytecode: string }> {
  const dir = process.env.REHEARSAL_ARTIFACTS;
  if (!dir) return artifacts.readArtifact(name);
  if (!frozenIndex) {
    frozenIndex = new Map();
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".json") && !e.name.endsWith(".dbg.json") && !frozenIndex!.has(e.name.slice(0, -5))) frozenIndex!.set(e.name.slice(0, -5), full);
      }
    };
    walk(join(dir, "src"));
    walk(join(dir, "@openzeppelin"));
  }
  const file = frozenIndex.get(name);
  if (!file) throw new Error(`no artifact ${name} under ${dir}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export async function at(name: string, address: string, runner: Signer | JsonRpcProvider = provider): Promise<Contract> {
  return new Contract(address, (await readArtifact(name)).abi as never, runner);
}

export async function deploy(name: string, signer: Signer, ...args: unknown[]): Promise<Contract> {
  const artifact = await readArtifact(name);
  const contract = await new ContractFactory(artifact.abi as never, artifact.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract as Contract;
}

export const erc20 = (address: string, runner: Signer | JsonRpcProvider = provider): Contract => new Contract(address, ERC20_ABI, runner);
export const colId = (token: string): string => solidityPackedKeccak256(["address"], [token]);

export interface System {
  snap: any;
  a: Record<string, string>;
  c: any;
  vault: Contract;
  oracle: Contract;
  gsusd: Contract;
  pool: Contract;
  reserve: Contract;
  buffer: Contract;
  sm: Contract;
  registry: Contract;
  silo: Contract;
  timelock: Contract;
  twap?: Contract;
  paxg: Contract;
  xaut: Contract;
  weth: Contract;
  uni: Contract;
  router: Contract;
}

/** The token and Uniswap handles alone, for the steps that run before deploy.ts. */
export function market0(): Pick<System, "paxg" | "xaut" | "weth" | "uni" | "router"> {
  return {
    paxg: erc20(ADDR.PAXG),
    xaut: erc20(ADDR.XAUT),
    weth: erc20(ADDR.WETH),
    uni: new Contract(ADDR.POOL, POOL_ABI, provider),
    router: new Contract(ADDR.ROUTER, ROUTER_ABI, provider),
  };
}

export async function system(): Promise<System> {
  await loadErrors();
  const path = resolve(__dirname, "../../deployments", `${network.name}.json`);
  const snap = JSON.parse(readFileSync(path, "utf8"));
  const a = snap.addresses, c = snap.config;
  return {
    snap, a, c,
    vault: await at("GoldVault", a.vault),
    oracle: await at("GoldOracle", a.oracle),
    gsusd: await at("GoldStablecoin", a.stablecoin),
    pool: await at("StabilityPool", a.stabilityPool),
    reserve: await at("GoldStabilityReserve", a.reserve),
    buffer: await at("SurplusBuffer", a.surplusBuffer),
    sm: await at("StabilityModule", a.stabilityModule),
    registry: await at("VaultRegistry", a.vaultRegistry),
    silo: await at("SiloFactory", a.siloFactory),
    timelock: await at("TimelockController", a.timelock),
    // P was removed from the production path (variant C); kept only for deployments that still have one
    twap: c.paxgConfirmFeed && c.paxgConfirmFeed !== "0x0000000000000000000000000000000000000000" ? await at("UniswapV3TwapFeed", c.paxgConfirmFeed) : undefined,
    paxg: erc20(ADDR.PAXG),
    xaut: erc20(ADDR.XAUT),
    weth: erc20(ADDR.WETH),
    uni: new Contract(ADDR.POOL, POOL_ABI, provider),
    router: new Contract(ADDR.ROUTER, ROUTER_ABI, provider),
  };
}

// ---------------------------------------------------------------- transactions and refusals

export async function exec(p: Promise<ContractTransactionResponse | TransactionResponse>): Promise<TransactionReceipt> {
  const tx = await p;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`transaction ${tx.hash} failed`);
  return receipt;
}

let errorIface: Interface | undefined;
async function loadErrors(): Promise<void> {
  if (errorIface) return;
  const seen = new Set<string>();
  const fragments: unknown[] = [];
  for (const name of ["GoldVault", "GoldOracle", "GoldStablecoin", "StabilityPool", "GoldStabilityReserve", "SurplusBuffer", "StabilityModule", "SiloFactory", "TimelockController", "ExpiringTimelockController", "UniswapV3TwapFeed"]) {
    for (const f of (await readArtifact(name)).abi as Array<{ type: string; name: string; inputs: Array<{ type: string }> }>) {
      const sig = `${f.name}(${(f.inputs ?? []).map((i) => i.type).join(",")})`;
      if (f.type === "error" && !seen.has(sig)) { seen.add(sig); fragments.push(f); }
    }
  }
  errorIface = new Interface(fragments as never);
}

export function reason(e: unknown): string {
  const x = e as { revert?: { name: string; args?: unknown[] }; reason?: string; shortMessage?: string; message?: string; data?: string; info?: { error?: { data?: unknown } } };
  if (x?.revert?.name && x.revert.name !== "Error") return `${x.revert.name}(${(x.revert.args ?? []).join(",")})`;
  if (x?.reason) return x.reason;
  const data = typeof x?.data === "string" ? x.data : undefined;
  if (data && data.length >= 10 && errorIface) {
    try {
      const parsed = errorIface.parseError(data);
      if (parsed) return `${parsed.name}(${parsed.args.join(",")})`;
    } catch {
      /* not a known error */
    }
  }
  return redactUrls(String(x?.shortMessage ?? x?.message ?? e)).slice(0, 240);
}

/** Expects a refusal; returns the reason. Fails when it went through or the reason differs. */
export async function expectRevert(p: Promise<unknown>, contains?: string): Promise<string> {
  try {
    await p;
  } catch (e) {
    const why = reason(e);
    if (contains && !why.includes(contains)) throw new Error(`refused with "${why}" instead of "${contains}"`);
    return why;
  }
  throw new Error(`did not refuse${contains ? ` (expected "${contains}")` : ""}`);
}

// ---------------------------------------------------------------- reporting

export class Report {
  readonly rows: Array<[string, "PASS" | "FAIL" | "INFO", string]> = [];
  constructor(readonly title: string) {
    console.log(`\n=== ${title} ===`);
  }
  async check(name: string, fn: () => Promise<string | void>): Promise<boolean> {
    try {
      const detail = (await fn()) || "";
      this.rows.push([name, "PASS", detail]);
      console.log(`  PASS  ${name}${detail ? ": " + detail : ""}`);
      return true;
    } catch (e) {
      const detail = reason(e);
      this.rows.push([name, "FAIL", detail]);
      console.log(`  FAIL  ${name}: ${detail}`);
      if (process.env.REHEARSAL_STACK) console.log(describeErrorStack(e));
      return false;
    }
  }
  info(name: string, detail: string): void {
    this.rows.push([name, "INFO", detail]);
    console.log(`  INFO  ${name}: ${detail}`);
  }
  finish(): void {
    const failed = this.rows.filter((r) => r[1] === "FAIL").length;
    const checks = this.rows.filter((r) => r[1] !== "INFO").length;
    console.log(`\n${this.title}: ${checks - failed}/${checks} checks passed${failed ? ` (${failed} FAILED)` : ""}`);
    if (failed) process.exitCode = 1;
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export const usd8 = (v: bigint): string => `$${Number(formatUnits(v, 8)).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const g18 = (v: bigint, dp = 4): string => Number(formatUnits(v, 18)).toLocaleString("en-GB", { maximumFractionDigits: dp });
export const pct = (ppm: bigint, dp = 3): string => `${(Number(ppm) / 10_000).toFixed(dp)}%`;
/** Signed distance of x from y in ppm of the larger, as GoldOracle._within measures it. */
export const gapPpm = (x: bigint, y: bigint): bigint => {
  const hi = x > y ? x : y;
  const lo = x > y ? y : x;
  return ((hi - lo) * PPM) / hi;
};
export const scale = (v: bigint, ppm: bigint): bigint => (v * ppm) / PPM;

// ---------------------------------------------------------------- Chainlink proxies

export const FEEDS = { C: ADDR.PAXG_USD, G: ADDR.XAU_USD, ETH: ADDR.ETH_USD } as const;
export type FeedName = keyof typeof FEEDS;

export const proxy = (address: string): Contract => new Contract(address, PROXY_ABI, provider);

export async function readFeed(address: string): Promise<{ answer: bigint; updatedAt: bigint; age: bigint; roundId: bigint }> {
  const [roundId, answer, , updatedAt] = await proxy(address).latestRoundData();
  return { answer, updatedAt, age: BigInt(await latestTs()) - updatedAt, roundId };
}

async function mockBehind(address: string): Promise<Contract | undefined> {
  const mock = await at("MockChainlinkFeed", await proxy(address).aggregator());
  try {
    await mock.setDecimals.staticCall(8);
    return mock;
  } catch {
    return undefined;
  }
}

/**
 * Point a real Chainlink EACAggregatorProxy at a mock aggregator: impersonate the proxy's owner
 * (Chainlink's multisig) and run the proxy's own two-step proposeAggregator/confirmAggregator.
 * The protocol keeps reading the REAL proxy address; only the answer behind it is ours. The mock
 * starts with the live answer and its timestamp, so the takeover changes nothing by itself.
 */
export async function takeOverFeed(address: string, operator: Signer): Promise<string> {
  const existing = await mockBehind(address);
  if (existing) return `${address} already answers from mock ${await existing.getAddress()}`;
  const p = proxy(address);
  const [description, live, phaseBefore, owner] = await Promise.all([p.description(), p.latestRoundData(), p.phaseId(), p.owner()]);
  const mock = await deploy("MockChainlinkFeed", operator, 8, description);
  await exec(mock.setLatestRoundData(1, live[1], live[3], live[3], 1));
  const ownerSigner = await impersonate(owner);
  await exec((p.connect(ownerSigner) as Contract).proposeAggregator(await mock.getAddress()));
  await exec((p.connect(ownerSigner) as Contract).confirmAggregator(await mock.getAddress()));
  const after = await p.latestRoundData();
  assert(after[1] === live[1] && after[3] === live[3], "the proxy does not answer the mock's round");
  return `${description} proxy ${address}: owner ${owner} confirmed mock ${await mock.getAddress()} (phase ${phaseBefore} -> ${await p.phaseId()}), answer ${usd8(live[1])} kept`;
}

let operatorWallet: Wallet | undefined;
async function operator(): Promise<Wallet> {
  operatorWallet ??= await wallet("feed-operator", 100n);
  return operatorWallet;
}

/** Set a taken-over feed's answer, stamped `ageSeconds` before the latest block. */
export async function setFeed(address: string, answer: bigint, ageSeconds = 0): Promise<void> {
  const mock = await mockBehind(address);
  if (!mock) throw new Error(`${address} has not been taken over (run scripts/rehearsal/baseline.ts)`);
  const [roundId] = await mock.latestRoundData();
  const stamp = BigInt(await latestTs()) - BigInt(ageSeconds);
  await exec((mock.connect(await operator()) as Contract).setLatestRoundData(roundId + 1n, answer, stamp, stamp, roundId + 1n));
}

/** Set any of C, G and ETH/USD and re-stamp the rest as fresh (one call per feed). */
export async function market(prices: Partial<Record<FeedName, bigint>>, ages: Partial<Record<FeedName, number>> = {}): Promise<Record<FeedName, bigint>> {
  const out = {} as Record<FeedName, bigint>;
  for (const name of Object.keys(FEEDS) as FeedName[]) {
    const answer = prices[name] ?? (await readFeed(FEEDS[name])).answer;
    await setFeed(FEEDS[name], answer, ages[name] ?? 0);
    out[name] = answer;
  }
  return out;
}

export const restamp = (): Promise<Record<FeedName, bigint>> => market({});

// ---------------------------------------------------------------- the PAXG/WETH pool

export const TWAP_STATUS = [
  "OK", "OBSERVE_FAILED", "BAD_OBSERVATION", "TICK_OUT_OF_RANGE", "THIN_LIQUIDITY",
  "QUOTE_FEED_FAILED", "QUOTE_INVALID", "QUOTE_STALE", "PRICE_OUT_OF_RANGE", "NO_RECENT_SWAPS",
];

export async function twapRead(sys: System, blockTag?: number): Promise<{ answer: bigint; status: string }> {
  if (!sys.twap) return { answer: 0n, status: "NONE" };
  const [answer, status] = await sys.twap.readPrice({ blockTag });
  return { answer, status: TWAP_STATUS[Number(status)] };
}

/** The pool's spot price of one PAXG in USD (8 decimals) at the current ETH/USD answer. */
export async function poolSpot(sys: Pick<System, "uni">): Promise<{ tick: bigint; sqrtP: bigint; liquidity: bigint; usd: bigint }> {
  const [slot0, liquidity, eth] = await Promise.all([sys.uni.slot0(), sys.uni.liquidity(), readFeed(ADDR.ETH_USD)]);
  const sqrtP: bigint = slot0[0];
  // price (WETH per PAXG, both 18 decimals) = (sqrtP / 2^96)^2; times ETH/USD (8 decimals)
  const usd = (sqrtP * sqrtP * eth.answer) >> 192n;
  return { tick: slot0[1], sqrtP, liquidity, usd };
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (n + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/** Funds a trading wallet with PAXG from the holder and WETH from ETH, approved for the router. */
export async function trader(sys: Pick<System, "paxg" | "weth">, label = "trader"): Promise<Wallet> {
  const w = await wallet(label, 1_000_000n);
  if ((await sys.paxg.balanceOf(w.address)) < 2_000n * E18) await fundPaxg(sys, w.address, 4_000n * E18);
  if ((await sys.weth.balanceOf(w.address)) < 20_000n * E18) await exec((sys.weth.connect(w) as Contract).deposit({ value: 60_000n * E18 }));
  for (const t of [sys.paxg, sys.weth]) {
    await exec((t.connect(w) as Contract).approve(ADDR.ROUTER, MAX));
  }
  return w;
}

/**
 * Move the pool's spot price to `ratioPpm` of where it stands with one real swap through
 * Uniswap's SwapRouter02, bounded by sqrtPriceLimitX96 so it stops exactly at the target.
 * Returns what the swap cost and where the price landed.
 */
export async function pushPool(sys: Pick<System, "paxg" | "weth" | "uni" | "router">, who: Wallet, ratioPpm: bigint): Promise<string> {
  const before = await poolSpot(sys);
  return poolTo(sys, who, (before.sqrtP * isqrt(ratioPpm * 10n ** 12n)) / 10n ** 9n);
}

/** Swap the pool to an absolute sqrtPriceX96 target (see pushPool). */
export async function poolTo(sys: Pick<System, "paxg" | "weth" | "uni" | "router">, who: Wallet, target: bigint): Promise<string> {
  const before = await poolSpot(sys);
  const zeroForOne = target < before.sqrtP; // PAXG is token0: selling it lowers the price
  const tokenIn = zeroForOne ? ADDR.PAXG : ADDR.WETH;
  const tokenOut = zeroForOne ? ADDR.WETH : ADDR.PAXG;
  const balIn = await erc20(tokenIn).balanceOf(who.address);
  const [paxgBefore, wethBefore]: bigint[] = await Promise.all([sys.paxg.balanceOf(who.address), sys.weth.balanceOf(who.address)]);
  await exec((sys.router.connect(who) as Contract).exactInputSingle({
    tokenIn, tokenOut, fee: 3000, recipient: who.address, amountIn: balIn, amountOutMinimum: 0, sqrtPriceLimitX96: target,
  }));
  const after = await poolSpot(sys);
  const [paxgAfter, wethAfter]: bigint[] = await Promise.all([sys.paxg.balanceOf(who.address), sys.weth.balanceOf(who.address)]);
  const moved = ((after.usd - before.usd) * PPM) / before.usd;
  return `pool ${usd8(before.usd)} -> ${usd8(after.usd)} (${moved >= 0n ? "+" : ""}${pct(moved, 2)}, tick ${before.tick} -> ${after.tick}, in-range L ${after.liquidity}); PAXG ${g18(paxgAfter - paxgBefore, 3)}, WETH ${g18(wethAfter - wethBefore, 3)}`;
}

/**
 * A small round trip that moves the price three ticks and back to exactly where it was, so the
 * pool records fresh observations after a long time jump. A Uniswap v3 pool writes an observation
 * only on a swap that changes the tick (or a liquidity change), so a tiny swap inside one tick
 * leaves the adapter at NO_RECENT_SWAPS.
 */
export async function pokePool(sys: Pick<System, "paxg" | "weth" | "uni" | "router">, who: Wallet): Promise<void> {
  const { sqrtP } = await poolSpot(sys);
  await poolTo(sys, who, (sqrtP * 1_000_150n) / 1_000_000n);
  await poolTo(sys, who, sqrtP);
}

// ---------------------------------------------------------------- tokens and vaults

export async function fundPaxg(sys: Pick<System, "paxg">, to: string, amount: bigint): Promise<bigint> {
  const holder = await impersonate(ADDR.PAXG_HOLDER);
  const before: bigint = await sys.paxg.balanceOf(to);
  await exec((sys.paxg.connect(holder) as Contract).transfer(to, amount));
  return (await sys.paxg.balanceOf(to)) - before;
}

export async function fundXaut(sys: Pick<System, "xaut">, to: string, amount: bigint): Promise<bigint> {
  const holder = await impersonate(ADDR.XAUT_HOLDER);
  const before: bigint = await sys.xaut.balanceOf(to);
  await exec((sys.xaut.connect(holder) as Contract).transfer(to, amount));
  return (await sys.xaut.balanceOf(to)) - before;
}

export interface Quote { ok: boolean; price: bigint; why: string }
export async function quote(sys: System, kind: "token" | "borrow" | "reserve" | "valuation", token: string = ADDR.PAXG, blockTag?: number): Promise<Quote> {
  const fn = { token: "quoteTokenPrice", borrow: "quoteBorrowPrice", reserve: "quoteReservePrice", valuation: "quoteValuationPrice" }[kind];
  try {
    const price: bigint = await sys.oracle.getFunction(fn)(token, { blockTag });
    return { ok: true, price, why: "" };
  } catch (e) {
    return { ok: false, price: 0n, why: reason(e) };
  }
}
export const showQuote = (q: Quote): string => (q.ok ? usd8(q.price) : `refused "${q.why}"`);

/** Mint in chunks under the per-block mint cap (each chunk is its own block on an automining node). */
export async function mintChunks(sys: System, who: Signer, amount: bigint): Promise<void> {
  const cap: bigint = await sys.vault.perBlockMintCap();
  let left = amount;
  while (left > 0n) {
    const chunk = cap > 0n && left > cap ? cap : left;
    await exec((sys.vault.connect(who) as Contract).mint(chunk));
    left -= chunk;
  }
}

export interface Opened { w: Wallet; credited: bigint; minted: bigint; borrowPrice: bigint }
/** A fresh wallet deposits `paxgIn` and mints to `ratioPpm` of the borrowing price (min(C, G, P)). */
export async function openVault(sys: System, label: string, paxgIn: bigint, ratioPpm: bigint): Promise<Opened> {
  const w = await wallet(label);
  const got = await fundPaxg(sys, w.address, paxgIn);
  await exec((sys.paxg.connect(w) as Contract).approve(sys.a.vault, got));
  await exec((sys.vault.connect(w) as Contract).deposit(ADDR.PAXG, got));
  const credited: bigint = (await sys.vault.vaults(w.address))[1];
  const borrowPrice: bigint = await sys.oracle.quoteBorrowPrice(ADDR.PAXG);
  const value = (credited * borrowPrice) / E8;
  const minted = (value * PPM) / ratioPpm;
  await mintChunks(sys, w, minted);
  await exec((sys.gsusd.connect(w) as Contract).approve(sys.a.vault, MAX));
  return { w, credited, minted, borrowPrice };
}

/** Ratio (ppm) of a vault at a given price, fee-inclusive debt, as the vault computes it. */
export async function ratioAt(sys: System, owner: string, price: bigint): Promise<bigint> {
  const v = await sys.vault.vaults(owner);
  const debt: bigint = await sys.vault.getVaultCurrentDebt(owner);
  if (debt === 0n) return MAX;
  return (((v[1] as bigint) * price) / E8) * PPM / debt;
}

export interface Liquidation {
  mode: "direct" | "pool" | "emergency";
  debtRepaid: bigint;
  seized: bigint;
  impliedPrice: bigint;
  block: number;
  gasUsed: bigint;
  liquidatorPaxg: bigint;
}

/** Liquidate and read back what the vault did; impliedPrice inverts _sizeSeizure (exact while the penalty fits). */
export async function liquidate(sys: System, by: Wallet, owner: string, mode: Liquidation["mode"], debt = 0n): Promise<Liquidation> {
  const penalty: bigint = (await sys.vault.collateralTypes(colId(ADDR.PAXG))).liquidationPenalty;
  const before: bigint = await sys.paxg.balanceOf(by.address);
  const vault = sys.vault.connect(by) as Contract;
  const call = mode === "pool" ? vault.liquidateViaPool(owner, debt) : mode === "emergency" ? vault.emergencyLiquidate(owner, debt) : vault.liquidate(owner, debt);
  const receipt = await exec(call);
  let debtRepaid = 0n, seized = 0n;
  for (const log of receipt.logs) {
    try {
      const parsed = sys.vault.interface.parseLog(log);
      if (parsed && (parsed.name === "Liquidated" || parsed.name === "LiquidatedViaPool")) {
        debtRepaid = parsed.args[2];
        seized = parsed.args[3];
      }
    } catch {
      /* another contract's log */
    }
  }
  assert(seized > 0n, "no liquidation event");
  const impliedPrice = (debtRepaid * (PPM + penalty) * E8) / (seized * PPM);
  return { mode, debtRepaid, seized, impliedPrice, block: receipt.blockNumber, gasUsed: receipt.gasUsed, liquidatorPaxg: (await sys.paxg.balanceOf(by.address)) - before };
}

/** True when two 8-decimal prices agree to one part in a million (seizure rounding only). */
export const samePrice = (x: bigint, y: bigint): boolean => (x > y ? x - y : y - x) * PPM <= y;

// ---------------------------------------------------------------- accounting

export interface Ledger {
  supply: bigint;
  paxgDebt: bigint;
  xautDebt: bigint;
  badDebt: bigint;
  principalSum: bigint;
  currentDebtSum: bigint;
  collateralSum: bigint;
  custody: bigint;
  owners: number;
  bufferGsusd: bigint;
  bufferPaxg: bigint;
  poolDeposits: bigint;
  poolPaxg: bigint;
  reservePaxg: bigint;
  reserveGsusd: bigint;
}

export async function ledger(sys: System): Promise<Ledger> {
  const count: bigint = await sys.registry.vaultOwnerCount();
  const owners: string[] = count > 0n ? await sys.registry.vaultOwners(0, count) : [];
  let principalSum = 0n, currentDebtSum = 0n, collateralSum = 0n;
  for (const o of owners) {
    const v = await sys.vault.vaults(o);
    if (v[0].toLowerCase() === ADDR.PAXG.toLowerCase()) collateralSum += v[1];
    principalSum += v[2];
    currentDebtSum += await sys.vault.getVaultCurrentDebt(o);
  }
  const xt = await sys.vault.collateralTypes(colId(ADDR.XAUT));
  return {
    supply: await sys.gsusd.totalSupply(),
    paxgDebt: (await sys.vault.collateralTypes(colId(ADDR.PAXG))).totalDebt,
    xautDebt: xt.active ? xt.totalDebt : 0n,
    badDebt: await sys.vault.totalBadDebt(),
    principalSum, currentDebtSum, collateralSum,
    custody: await sys.silo.totalCollateral(ADDR.PAXG),
    owners: owners.length,
    bufferGsusd: await sys.gsusd.balanceOf(sys.a.surplusBuffer),
    bufferPaxg: await sys.paxg.balanceOf(sys.a.surplusBuffer),
    poolDeposits: await sys.pool.getTotalDeposits(),
    poolPaxg: await sys.paxg.balanceOf(sys.a.stabilityPool),
    reservePaxg: await sys.reserve.collateralBalance(ADDR.PAXG),
    reserveGsusd: await sys.reserve.gsusdInventory(),
  };
}

/** supply == aggregate principal + unabsorbed bad debt; the registry sums agree with the books; custody == credited collateral. */
export function identity(l: Ledger): string {
  const debt = l.paxgDebt + l.xautDebt;
  assert(l.supply === debt + l.badDebt, `supply ${g18(l.supply)} != principal ${g18(debt)} + bad debt ${g18(l.badDebt)}`);
  assert(l.principalSum === debt, `registry principal ${g18(l.principalSum)} != collateral-type totals ${g18(debt)}`);
  assert(l.custody === l.collateralSum, `silo custody ${g18(l.custody)} PAXG != credited ${g18(l.collateralSum)} PAXG`);
  return `supply ${g18(l.supply, 6)} = principal ${g18(debt, 6)} + bad debt ${g18(l.badDebt, 6)}; accrued unbanked fees ${g18(l.currentDebtSum - l.principalSum, 6)}; buffer ${g18(l.bufferGsusd, 6)} GSUSD + ${g18(l.bufferPaxg, 6)} PAXG; pool ${g18(l.poolDeposits, 2)} GSUSD + ${g18(l.poolPaxg, 6)} PAXG; reserve ${g18(l.reservePaxg, 6)} PAXG + ${g18(l.reserveGsusd, 2)} GSUSD; custody ${g18(l.custody, 6)} PAXG over ${l.owners} vaults`;
}

export function delta(before: Ledger, after: Ledger): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const k of Object.keys(before) as Array<keyof Ledger>) {
    if (typeof before[k] === "bigint") out[k] = (after[k] as bigint) - (before[k] as bigint);
  }
  return out;
}

/** The deterministic actors the baseline funds and every scenario reuses. */
export const actors = {
  bank: () => wallet("bank"),
  keeper: () => wallet("keeper"),
};

// ---------------------------------------------------------------- scenario harness

/**
 * Run one scenario inside an evm_snapshot, so every scenario starts from the same baseline
 * (scripts/rehearsal/baseline.ts). REHEARSAL_KEEP=1 leaves the state in place instead.
 */
export async function scenario(title: string, body: (sys: System, r: Report) => Promise<void>): Promise<void> {
  const fork = await assertFork();
  const sys = await system();
  const r = new Report(title);
  console.log(`  fork chain ${fork.chainId}, block ${fork.block}; deployment ${network.name}.json, vault ${sys.a.vault}`);
  const id = await snapshot();
  try {
    await restamp();
    await body(sys, r);
  } catch (e) {
    r.rows.push(["scenario aborted", "FAIL", reason(e)]);
    console.log(`  FAIL  scenario aborted: ${reason(e)}`);
    console.log(describeErrorStack(e));
  } finally {
    if (process.env.REHEARSAL_KEEP === "1") console.log("  (state kept: REHEARSAL_KEEP=1)");
    else await revertTo(id);
    r.finish();
  }
}

/** Let `seconds` of fork time pass in `step` increments, re-stamping every feed at each step. */
export async function hold(seconds: number, step: number, each?: (elapsed: number) => Promise<void>): Promise<void> {
  for (let elapsed = step; elapsed <= seconds; elapsed += step) {
    await advance(step);
    await restamp();
    if (each) await each(elapsed);
  }
}

/**
 * A market-wide move: C and G by `ratioPpm` at once, the pool pushed by the same ratio with a real
 * swap, then time passes until the pool's median has followed (within 0.5% of C) or `maxSeconds`.
 */
export async function driftMarket(sys: System, who: Wallet, ratioPpm: bigint, maxSeconds = 2400): Promise<string> {
  const before = await market({});
  const swap = await pushPool(sys, who, ratioPpm);
  const now = await market({ C: scale(before.C, ratioPpm), G: scale(before.G, ratioPpm) });
  let waited = 0;
  if (!sys.twap) return `C ${usd8(before.C)} -> ${usd8(now.C)}, G ${usd8(before.G)} -> ${usd8(now.G)}; ${swap} (the pool is no longer a price source)`;
  for (; waited < maxSeconds; waited += 150) {
    const p = await twapRead(sys);
    if (p.status === "OK" && gapPpm(p.answer, now.C) <= 5_000n) break;
    await advance(150);
    await restamp();
  }
  const p = await twapRead(sys);
  return `C ${usd8(before.C)} -> ${usd8(now.C)}, G ${usd8(before.G)} -> ${usd8(now.G)}; ${swap}; P ${p.status} ${usd8(p.answer)} after ${waited} s`;
}

/**
 * A governance action as the deployment stands: sent by the deployer before the handover, or,
 * after it, scheduled by the proposer Safe through the timelock, 48 hours of fork time passed
 * (feeds re-stamped and the pool refreshed) and executed by the executor Safe.
 */
export async function govern(sys: System, label: string, calls: Array<{ to: string; data: string }>): Promise<string> {
  if (await sys.vault.hasRole(id("GOVERNANCE_ROLE"), sys.snap.deployer)) {
    const d = await impersonate(sys.snap.deployer);
    for (const c of calls) await exec(d.sendTransaction({ to: c.to, data: c.data }));
    return `${label} sent by the deployer (governance not yet handed over)`;
  }
  const proposer = await impersonate(sys.c.proposers[0]);
  const executor = await impersonate(sys.c.executors[0]);
  const targets = calls.map((c) => c.to);
  const values = calls.map(() => 0);
  const payloads = calls.map((c) => c.data);
  const salt = id(`${label}:${await latestTs()}`);
  const delay: bigint = await sys.timelock.getMinDelay();
  await exec((sys.timelock.connect(proposer) as Contract).scheduleBatch(targets, values, payloads, ZeroHash, salt, delay));
  await advance(Number(delay) + 1);
  await restamp();
  await pokePool(sys, await trader(sys));
  await exec((sys.timelock.connect(executor) as Contract).executeBatch(targets, values, payloads, ZeroHash, salt));
  return `${label} scheduled by the proposer Safe and executed by the executor Safe ${delay / 3600n} h later`;
}


/** Variant C (plan section 3): the prices each path should give for healthy C and G. */
export function variantC(c: bigint, g: bigint, bandPpm = 20_000n, clampPpm = 20_000n): { liq: bigint; borrow: bigint | undefined; reserve: bigint | undefined; valuation: bigint } {
  const edge = (w: bigint, up: boolean): bigint => (g * (up ? PPM + w : PPM - w)) / PPM;
  const inBand = c >= edge(bandPpm, false) && c <= edge(bandPpm, true);
  const hi = c > g ? c : g;
  return {
    liq: hi > edge(clampPpm, true) ? edge(clampPpm, true) : hi,
    borrow: inBand ? (c < g ? c : g) : undefined,
    reserve: inBand ? hi : undefined,
    valuation: c < g ? c : g,
  };
}

// ---------------------------------------------------------------- the launch scripts, as an operator runs them

export interface ScriptRun { code: number; out: string }

/**
 * Run one of the launch scripts in its own Hardhat process against the same fork, exactly as an
 * operator would (`npx hardhat run <script> --network localhost`), with `env` added to this
 * process's environment. Returns the exit code and everything it printed.
 */
export function runScript(script: string, env: Record<string, string> = {}): ScriptRun {
  rpcUrl();
  const run = spawnSync("npx", ["hardhat", "run", "--no-compile", script, "--network", "localhost"], {
    cwd: resolve(__dirname, "../.."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 600_000,
  });
  if (run.error) throw new Error(`${script} did not run: ${redactUrls(run.error.message)}`);
  return { code: run.status ?? -1, out: redactUrls(`${run.stdout ?? ""}${run.stderr ?? ""}`) };
}

export interface PrintedTransaction { title: string; to: string; value: bigint; data: string; decoded: string }

/**
 * The transactions a printer wrote, in order, read from its output as an operator would copy
 * them into the Safe Transaction Builder: a title line, then to, value, data and decoded.
 */
export function printedTransactions(out: string): PrintedTransaction[] {
  const found: PrintedTransaction[] = [];
  const pattern = /^(.*)\n\s+to:\s+(0x[0-9a-fA-F]{40})\n\s+value:\s+(\d+)\n\s+data:\s+(0x[0-9a-fA-F]*)\n\s+decoded:\s+(.*)$/gm;
  for (const m of out.matchAll(pattern)) found.push({ title: m[1].trim(), to: m[2], value: BigInt(m[3]), data: m[4], decoded: m[5].trim() });
  return found;
}
