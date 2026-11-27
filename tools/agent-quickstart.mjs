#!/usr/bin/env node
// The smallest honest client of the protocol: reads the agent manifest, proves its address
// set against the chain with no ABI, then lists the open vaults with their state. Everything
// an agent needs to start, in one file it can read in a minute.
//
// The proof is strict on purpose. A manifest is a claim, and a list of checks written by the
// same hand as the addresses proves only that the two agree, so before any address is used:
// the entry must describe the chain it is filed under; a manifest from anywhere but this tree
// must name exactly the addresses in the address book that ships with this tool; the wiring
// is then rebuilt from the addresses with calldata, labels and expected words that belong to
// this tool, and every call must answer as the wiring requires; only then is the manifest's
// own list replayed with its labels shown as its claims; it too must cover every address and
// get back the exact word it promised. A manifest that fails any of these is refused whole.
// The book anchors addresses alone, so the network name, generation date, deploy block,
// collateral symbols, ratios, active flags and minting note of a manifest from elsewhere are
// printed as its claims and its decimals are never used. Each claim is printed on a single
// line, and so is every manifest string a refusal quotes. An address that is neither all lower
// case nor a valid EIP-55 checksum is refused, since no call could be made with it. So is a
// manifest that is not JSON, without quoting it, or not a JSON object.
//
//   node tools/agent-quickstart.mjs                     # Sepolia, manifest from this tree
//   RPC_URL=<url> node tools/agent-quickstart.mjs <manifest path or URL> [chainId]
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseError, ContractFunctionRevertedError, createPublicClient, encodeFunctionData, formatUnits, http, isAddress as passesChecksum, keccak256, pad, parseAbi, toHex } from "viem";

const SCHEMA = "goldstandard-agents/1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED_MANIFEST = resolve(root, "apps/dapp/public/agents.json");
const DEFAULT_RPC = { 11155111: "https://sepolia.gateway.tenderly.co", 1: "https://ethereum.publicnode.com" };
/** The deployment record this tool trusts for each chain, by its name under contracts/deployments. */
const ADDRESS_BOOKS = { 11155111: "sepolia", 1: "mainnet" };

const registryAbi = parseAbi([
  "function vaultOwnerCount() view returns (uint256)",
  "function vaultOwners(uint256 offset, uint256 limit) view returns (address[])",
  "struct VaultSummary { address token; uint256 collateral; uint256 debt; uint256 ratio; uint256 liquidationPrice; bool liquidatable; }",
  "function vaultSummary(address owner) view returns (VaultSummary)",
]);
const oracleAbi = parseAbi([
  "function quoteTokenPrice(address token) view returns (uint256)",
  "function quoteBorrowPrice(address token) view returns (uint256)",
  "function paxgToken() view returns (address)",
  "function xautToken() view returns (address)",
]);

/**
 * One of the oracle's quote views as a line of output: the price, or "refused" with the
 * reason when the view reverts exactly as the call it mirrors would. Anything other than a
 * revert (an unreachable RPC) is thrown, never shown as a refusal. The quickstart
 * once printed getValidatedPrice, the market feed alone, which cannot say whether
 * the gold reference is healthy and so whether the vault would price at all.
 */
export async function describeQuote(readContract, oracle, functionName, token) {
  try {
    const price = await readContract({ address: oracle, abi: oracleAbi, functionName, args: [token] });
    return `$${formatUnits(price, 8)}`;
  } catch (error) {
    const revert = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null;
    if (!(revert instanceof ContractFunctionRevertedError)) throw error;
    return revert.reason ? `refused (${revert.reason})` : "refused";
  }
}

/** A reason to refuse the manifest whole; the script prints it and exits with status 1. */
export class Refusal extends Error {}

function fail(message) {
  throw new Refusal(message);
}

/**
 * The manifest text parsed. A parse error's message quotes the text it failed on, line
 * breaks included, so a manifest that is not JSON is refused without quoting any of it.
 */
function parseManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("The manifest is not valid JSON. Do not use it.");
  }
  // null, a list, a string or a number is valid JSON but no manifest.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("The manifest is not a JSON object. Do not use it.");
  }
  return parsed;
}

async function loadManifest(from) {
  if (/^https?:\/\//.test(from)) {
    const response = await fetch(from);
    if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`);
    // Read as text, so a body that is not JSON is refused while a failed read still throws.
    return parseManifest(await response.text());
  }
  return parseManifest(readFileSync(from, "utf8"));
}

const isAddress = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isWord = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * True for an address spelling viem will encode: all lower case, or mixed case with a valid
 * EIP-55 checksum. Any other spelling makes the first call that names it throw, so a manifest
 * that uses one is refused before any call is made.
 */
const isSpeltValidly = (value) => isAddress(value) && passesChecksum(value);

/**
 * Why the listed spellings cannot be used, with "it" or "them" by count. An all upper case
 * address has no checksum at all, so a refusal never calls the spelling a broken checksum.
 */
function unusableSpelling(count, preposition) {
  return count === 1
    ? `an address that is neither all lower case nor a valid EIP-55 checksum, so no call can be made ${preposition} it`
    : `each an address that is neither all lower case nor a valid EIP-55 checksum, so no call can be made ${preposition} them`;
}

/**
 * True for a character that could end a line or move the cursor: every C0 control (ESC, CR
 * and LF among them), DEL, every C1 control and the Unicode line and paragraph separators.
 */
const breaksLine = (code) => code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

/**
 * True for a Unicode bidirectional control, which reorders the text displayed around it, so a
 * line could show words it does not contain: the three direction marks (U+061C, U+200E and
 * U+200F), the embeddings and overrides with their pop (U+202A to U+202E) and the isolates with
 * theirs (U+2066 to U+2069).
 */
const reordersText = (code) =>
  code === 0x061c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/**
 * A manifest string confined to one line: every control character, a newline among them, and
 * every bidirectional control is printed as its \u escape, so a claim or a refusal can never
 * print text of the manifest's choosing as a line of its own or display it out of order.
 */
export function oneLine(value) {
  return Array.from(String(value), (char) => {
    const code = char.codePointAt(0);
    return breaksLine(code) || reordersText(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }).join("");
}

const roleAbi = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);
const wiringAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function stablecoin() view returns (address)",
  "function oracle() view returns (address)",
  "function stabilityModule() view returns (address)",
  "function stabilityPool() view returns (address)",
  "function surplusBuffer() view returns (address)",
  "function stabilityReserve() view returns (address)",
  "function siloFactory() view returns (address)",
  "function vaultRegistry() view returns (address)",
  "function vault() view returns (address)",
  "function gsusd() view returns (address)",
  "function getTimelockAddress() view returns (address)",
  "function vaultRoleLocked() view returns (bool)",
  "function absorptionBurns() view returns (bool)",
]);
const MINTER_ROLE = keccak256(toHex("MINTER_ROLE"));
const VAULT_ROLE = keccak256(toHex("VAULT_ROLE"));
const PROPOSER_ROLE = keccak256(toHex("PROPOSER_ROLE"));
const TRUE_WORD = pad("0x01");
const FALSE_WORD = pad("0x00");
/** The contracts the wiring checks read; a set without any one of them cannot be proved. */
const WIRED = ["oracle", "stablecoin", "stabilityModule", "vault", "surplusBuffer", "stabilityPool", "reserve", "siloFactory", "vaultRegistry"];

/**
 * The wiring every genuine set satisfies, rebuilt from its addresses alone the way the
 * manifest generator builds its list (verificationOf in contracts/scripts/lib/agentManifest.ts).
 * The calldata, the labels and the expected words belong to this tool, so a manifest chooses
 * which addresses are asked but never the question or the answer that counts as a pass.
 */
export function wiringChecks(a) {
  const hasRole = (check, at, role, account, held) => ({
    check,
    to: a[at],
    data: encodeFunctionData({ abi: roleAbi, functionName: "hasRole", args: [role, a[account]] }),
    result: held ? TRUE_WORD : FALSE_WORD,
  });
  const reads = (check, at, functionName, result) => ({ check, to: a[at], data: encodeFunctionData({ abi: wiringAbi, functionName }), result });
  const pointsTo = (check, at, functionName, target) => reads(check, at, functionName, pad(a[target].toLowerCase()));
  const checks = [
    hasRole("GoldStablecoin: the listed vault holds MINTER_ROLE", "stablecoin", MINTER_ROLE, "vault", true),
    reads("GoldStablecoin.decimals() is 18", "stablecoin", "decimals", pad(toHex(18))),
    pointsTo("GoldVault.stablecoin() is the listed GSUSD token", "vault", "stablecoin", "stablecoin"),
    pointsTo("GoldVault.oracle() is the listed oracle", "vault", "oracle", "oracle"),
    pointsTo("GoldVault.stabilityModule() is the listed stability module", "vault", "stabilityModule", "stabilityModule"),
    pointsTo("GoldVault.stabilityPool() is the listed pool", "vault", "stabilityPool", "stabilityPool"),
    pointsTo("GoldVault.surplusBuffer() is the listed surplus buffer", "vault", "surplusBuffer", "surplusBuffer"),
    pointsTo("GoldVault.stabilityReserve() is the listed reserve", "vault", "stabilityReserve", "reserve"),
    pointsTo("GoldVault.siloFactory() is the listed silo factory", "vault", "siloFactory", "siloFactory"),
    pointsTo("GoldVault.vaultRegistry() is the listed registry", "vault", "vaultRegistry", "vaultRegistry"),
    pointsTo("VaultRegistry.vault() is the listed vault", "vaultRegistry", "vault", "vault"),
    hasRole("StabilityModule: the listed vault holds VAULT_ROLE", "stabilityModule", VAULT_ROLE, "vault", true),
    hasRole("SurplusBuffer: the listed vault holds VAULT_ROLE", "surplusBuffer", VAULT_ROLE, "vault", true),
    hasRole("StabilityPool: the listed vault holds VAULT_ROLE", "stabilityPool", VAULT_ROLE, "vault", true),
    hasRole("SiloFactory: the listed vault holds VAULT_ROLE", "siloFactory", VAULT_ROLE, "vault", true),
    pointsTo("GoldStabilityReserve.gsusd() is the listed GSUSD token", "reserve", "gsusd", "stablecoin"),
    pointsTo("GoldStabilityReserve.oracle() is the listed oracle", "reserve", "oracle", "oracle"),
    hasRole("GoldStablecoin: the listed reserve holds no MINTER_ROLE", "stablecoin", MINTER_ROLE, "reserve", false),
    reads("SiloFactory.vaultRoleLocked() is true", "siloFactory", "vaultRoleLocked", TRUE_WORD),
    reads("SurplusBuffer.absorptionBurns() is true (the current contract generation)", "surplusBuffer", "absorptionBurns", TRUE_WORD),
  ];
  if (isAddress(a.governance)) {
    checks.push(pointsTo("GoldGovernance.vault() is the listed vault", "governance", "vault", "vault"));
    if (isAddress(a.timelock)) {
      checks.push(
        pointsTo("GoldGovernance.getTimelockAddress() is the listed timelock", "governance", "getTimelockAddress", "timelock"),
        hasRole("TimelockController: the listed governance wrapper holds PROPOSER_ROLE", "timelock", PROPOSER_ROLE, "governance", true),
      );
    }
  }
  return checks;
}

/**
 * The address book this tool ships for a chain, or null when it ships none. It is the deploy
 * script's own record, contracts/deployments/<network>.json in this tree: the manifest beside
 * it is generated from that file and a test keeps the two equal, so it is the one anchor that
 * does not come from the document under test. A manifest from anywhere else must name exactly
 * these addresses, which also refuses a complete look-alike deployment that is consistent with
 * itself.
 */
export function shippedAddressBook(chainId) {
  const network = ADDRESS_BOOKS[chainId];
  if (!network) return null;
  const path = resolve(root, "contracts/deployments", `${network}.json`);
  if (!existsSync(path)) return null;
  const book = JSON.parse(readFileSync(path, "utf8"));
  return book.chainId === Number(chainId) && book.addresses ? book.addresses : null;
}

/** The names whose address differs between the manifest's set and the address book, in either direction. */
function unanchoredNames(addresses, book) {
  const names = new Set([...Object.keys(book), ...Object.keys(addresses ?? {})]);
  return [...names].filter((name) => String(book[name] ?? "").toLowerCase() !== String(addresses?.[name] ?? "").toLowerCase());
}

/**
 * The shape checks that need no chain: a problem list, empty when the list is worth replaying.
 * Every manifest string a problem quotes passes through oneLine.
 */
function shapeProblems(network) {
  const addresses = network.addresses ?? {};
  const names = Object.keys(addresses).filter((name) => isAddress(addresses[name]));
  const entries = Array.isArray(network.verification) ? network.verification : [];
  const problems = [];
  if (names.length === 0) problems.push("the network lists no addresses");
  const unwired = WIRED.filter((name) => !isAddress(addresses[name]));
  if (unwired.length > 0) problems.push(`the address set lacks ${unwired.join(", ")}, so its wiring cannot be checked`);
  const misspelt = names.filter((name) => !isSpeltValidly(addresses[name]));
  if (misspelt.length > 0) {
    const spellings = misspelt.map((name) => `${oneLine(name)} as ${oneLine(addresses[name])}`);
    problems.push(`the address set spells ${spellings.join(", ")}, ${unusableSpelling(misspelt.length, "to")}`);
  }
  if (entries.length === 0) problems.push("the verification list is empty, so nothing proves these addresses belong together");
  // An entry that is not an object is reported by its index in the list, counting from 0, and
  // left out of every check below, so a null cannot crash the tool.
  entries.forEach((entry, index) => {
    if (!isObject(entry)) problems.push(`verification entry ${index} is not an object`);
  });
  const checks = entries.filter(isObject);
  const covered = new Set(checks.map((check) => check.address));
  const uncovered = names.filter((name) => !covered.has(name));
  if (uncovered.length > 0) problems.push(`no verification call targets ${uncovered.map((name) => oneLine(name)).join(", ")}`);
  for (const check of checks) {
    const label = `check "${oneLine(check.check ?? "?")}"`;
    if (typeof check.address !== "string" || !Object.hasOwn(addresses, check.address) || !isAddress(addresses[check.address])) {
      problems.push(`${label} names "${oneLine(check.address)}", which is not in the address set`);
      continue;
    }
    const listed = addresses[check.address];
    if (!isAddress(check.to) || check.to.toLowerCase() !== listed.toLowerCase()) {
      problems.push(`${label} calls ${oneLine(check.to)}, not the listed ${oneLine(check.address)} ${oneLine(listed)}`);
    } else if (!isSpeltValidly(check.to)) {
      problems.push(`${label} spells its target ${oneLine(check.to)}, ${unusableSpelling(1, "to")}`);
    }
    if (typeof check.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(check.data)) problems.push(`${label} has no calldata`);
    if (!isWord(check.result)) problems.push(`${label} does not promise a 32 byte word`);
  }
  return { problems, names, checks };
}

/**
 * The whole run. `transport`, `addressBook` and `log` exist for the tests, which answer every
 * eth_call from an in-process model of the chain and read the output back.
 */
export async function main({ source = SHIPPED_MANIFEST, chainArg = "11155111", transport, addressBook = shippedAddressBook, log = console.log } = {}) {
  const manifest = await loadManifest(source);
  if (manifest.schema !== SCHEMA) fail(`unexpected manifest schema ${oneLine(manifest.schema)}; this client reads ${SCHEMA}`);
  const network = manifest.networks?.[chainArg];
  if (!network || network.status === "not deployed") fail(`chain ${chainArg} is not deployed in this manifest`);
  // The address book below is chosen by the chain the caller names, while the RPC is held to
  // the chain the entry describes. Unless the two are one chain, an entry filed under Sepolia
  // could be checked against the Sepolia book and then read from another chain.
  if (network.chainId !== Number(chainArg)) {
    fail(`The manifest files an entry under chain ${chainArg} that describes chain ${oneLine(network.chainId)}, so its addresses would be checked against one chain and read from another. Do not use it.`);
  }

  // 0. A manifest from outside this tree is held to the address book that ships with the tool,
  // before any address reaches the chain. With no book for the chain it is refused, never trusted.
  const inTree = !/^https?:\/\//.test(source) && resolve(source) === SHIPPED_MANIFEST;
  if (!inTree) {
    const book = addressBook(chainArg);
    if (!book) fail(`No address book for chain ${chainArg} ships with this tool, so a manifest from ${source} has nothing to be checked against. Do not use it.`);
    const differs = unanchoredNames(network.addresses, book);
    if (differs.length > 0) {
      fail(`These entries of the manifest differ from the address book shipped with this tool: ${differs.map((name) => oneLine(name)).join(", ")}. Do not use these addresses.`);
    }
  }

  // From outside this tree the book anchors the addresses alone, so every other word the
  // manifest supplies, its minting note among them, is printed as its claim on a single
  // line; what the chain returns is fact.
  const asClaim = (line) => (inTree ? line : `manifest claim: ${oneLine(line)}`);

  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC[Number(chainArg)];
  const client = createPublicClient({ transport: transport ?? http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== network.chainId) fail(`RPC answers chain ${chainId}, manifest describes ${oneLine(network.chainId)}`);
  // Only the chain id on this line comes from the RPC; the rest is what the manifest says of itself.
  const generated = `generated ${manifest.generatedAt}, deployed at block ${network.deployBlock}`;
  log(
    inTree
      ? `${network.name} (chain ${chainId})\nmanifest ${generated}\n`
      : `chain ${chainId}, as the RPC reports it\n${asClaim(`network ${network.name}, ${generated}`)}\n`,
  );

  // 1. Prove the address set belongs together: shape first, then this tool's own wiring checks,
  // then the manifest's list as raw eth_calls. Its labels are claims; only the answers are proof.
  const { problems, names, checks } = shapeProblems(network);
  if (problems.length > 0) fail(`The manifest cannot be verified:\n  - ${problems.join("\n  - ")}\nDo not use these addresses.`);
  const wiring = wiringChecks(network.addresses);
  const answers = async (check) => {
    let data = "0x";
    try {
      ({ data = "0x" } = await client.call({ to: check.to, data: check.data }));
    } catch {
      data = "0x";
    }
    return data.toLowerCase() === check.result.toLowerCase();
  };
  let failed = 0;
  for (const [check, label] of [...wiring.map((c) => [c, c.check]), ...checks.map((c) => [c, `manifest claim: ${oneLine(c.check)}`])]) {
    const ok = await answers(check);
    if (!ok) failed += 1;
    log(`${ok ? "ok  " : "FAIL"} ${label}`);
  }
  const total = wiring.length + checks.length;
  if (failed > 0) fail(`\n${failed} of ${total} verification call(s) failed: do not use these addresses.`);
  log(`\nVerified ${names.length} addresses with ${wiring.length} wiring calls of this tool and the ${checks.length} calls the manifest lists.\n`);
  if (network.minting?.note) {
    log(inTree ? `The manifest notes: ${oneLine(network.minting.note)}\n` : `${asClaim(network.minting.note)}\n`);
  }

  // 2. The collateral list is part of the claim too: the verification proves the oracle, so the
  // tokens the manifest calls collateral must be exactly the two the oracle itself reports.
  const { addresses, collateral } = network;
  if (!Array.isArray(collateral) || collateral.some((asset) => !isAddress(asset?.token))) {
    fail("The manifest collateral list is malformed: every entry needs a token address. Do not use it.");
  }
  const misspeltTokens = collateral.map((asset) => asset.token).filter((token) => !isSpeltValidly(token));
  if (misspeltTokens.length > 0) {
    fail(`The manifest collateral spells ${misspeltTokens.map((token) => oneLine(token)).join(", ")}, ${unusableSpelling(misspeltTokens.length, "with")}. Do not use it.`);
  }
  const oracleTokens = await Promise.all(
    ["paxgToken", "xautToken"].map((functionName) => client.readContract({ address: addresses.oracle, abi: oracleAbi, functionName })),
  );
  const onChain = oracleTokens.map((token) => token.toLowerCase()).sort();
  const listed = collateral.map((asset) => asset.token.toLowerCase()).sort();
  if (onChain.length !== listed.length || onChain.some((token, index) => token !== listed[index])) {
    fail(`The manifest collateral (${listed.join(", ")}) is not what the oracle reports (${onChain.join(", ")}). Do not use it.`);
  }

  // 3. Prices the vault would use right now: liquidation at quoteTokenPrice, borrowing at
  // quoteBorrowPrice, each refused while the rule it applies has no price. From outside this
  // tree the prices are facts keyed by the token address the oracle reported, and the symbol,
  // ratios and active flag follow on a line of their own as the manifest's claims.
  const read = (args) => client.readContract(args);
  const oracleForm = Object.fromEntries(oracleTokens.map((token) => [token.toLowerCase(), token]));
  for (const asset of collateral) {
    const token = oracleForm[asset.token.toLowerCase()];
    const ratios = `liquidation below ${asset.liquidationRatioPpm / 10_000}%, mint above ${asset.minRatioPpm / 10_000}%`;
    // A registered but inactive token (XAUT under the open launch) has no collateral type yet.
    if (asset.active === false) {
      if (inTree) {
        log(`${asset.symbol} registered in the oracle, not accepted as collateral`);
      } else {
        log(`${token} registered in the oracle, prices not read`);
        log(asClaim(`${token} is ${asset.symbol}, not accepted as collateral`));
      }
      continue;
    }
    // The oracle's own spelling of the token, never the manifest's.
    const liquidation = await describeQuote(read, addresses.oracle, "quoteTokenPrice", token);
    const borrowing = await describeQuote(read, addresses.oracle, "quoteBorrowPrice", token);
    if (inTree) {
      log(`${asset.symbol} liquidation ${liquidation}, borrowing ${borrowing} (${ratios})`);
    } else {
      log(`${token} liquidation ${liquidation}, borrowing ${borrowing}`);
      log(asClaim(`${token} is ${asset.symbol}, ${ratios}`));
    }
  }

  // 4. Every open vault, from the registry the vault itself maintains.
  const count = await client.readContract({ address: addresses.vaultRegistry, abi: registryAbi, functionName: "vaultOwnerCount" });
  log(`\n${count} open vault(s)`);
  const bySymbol = Object.fromEntries(collateral.map((asset) => [asset.token.toLowerCase(), asset]));
  for (let offset = 0n; offset < count; offset += 200n) {
    const owners = await client.readContract({ address: addresses.vaultRegistry, abi: registryAbi, functionName: "vaultOwners", args: [offset, 200n] });
    for (const owner of owners) {
      const s = await client.readContract({ address: addresses.vaultRegistry, abi: registryAbi, functionName: "vaultSummary", args: [owner] });
      const asset = bySymbol[s.token.toLowerCase()];
      // A claimed decimals figure would scale the amount shown, so from outside this tree the
      // amount stays as the chain returned it, in the token's base units.
      const held = inTree ? `${formatUnits(s.collateral, asset?.decimals ?? 18)} ${asset?.symbol ?? s.token}` : `${s.collateral} base units of ${s.token}`;
      const ratio = s.debt === 0n ? "no debt" : `${(Number(s.ratio) / 10_000).toFixed(2)}%`;
      log(`  ${owner}  ${held}  debt ${formatUnits(s.debt, 18)} GSUSD  ratio ${ratio}${s.liquidatable ? "  LIQUIDATABLE" : ""}`);
    }
  }
  // The guide link is part of the claim too: only the manifest in this tree may choose it.
  const guide = inTree ? manifest.source.guide : "docs/AGENTS.md in the protocol's repository";
  log(`\nNext: ${guide} for the calls that act on what you just read.`);
}

// Run only as a script, so the test can import describeQuote without touching a chain.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , source, chainArg] = process.argv;
  try {
    await main({ source, chainArg });
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
