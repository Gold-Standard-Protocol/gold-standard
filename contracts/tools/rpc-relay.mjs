#!/usr/bin/env node
// Local JSON-RPC relay with per-request timeouts, retries and fail-over across public Sepolia
// gateways, so one hung or rate-limited upstream never stalls a long Hardhat run (the drive,
// a seeding ceremony). Point RPC_URL at http://127.0.0.1:8555 while it runs:
//   node contracts/tools/rpc-relay.mjs &
//   RPC_URL=http://127.0.0.1:8555 npx hardhat run scripts/rehearse-testnet-flow.ts --network sepolia
// UPSTREAMS may be overridden as a comma-separated list (mainnet gateways for a mainnet run).
//
// Read-after-write consistency: public gateways balance across nodes that can lag a block, so a
// read right after a transaction may not see it. The relay remembers the newest block any
// receipt or block query reported and rewrites "latest" (and non-nonce "pending") reads to
// that block; a node that does not have it yet answers "header not found" and the request
// moves on to one that does. Gas estimates cannot be pinned the same way: run in a mined
// block's context they under-price the next block (warm storage) and mis-judge block-scoped
// state (the vault's per-block mint cap), both seen in practice. Each estimate therefore
// travels unchanged in one HTTP batch together with eth_blockNumber, so one node answers
// both, and an answer from a node still below the high-water mark is dropped and re-asked.
// Nonces get the same treatment: the relay remembers the highest nonce each sender has
// signed (parsed from eth_sendRawTransaction) and never answers eth_getTransactionCount
// below that plus one, so a lagging node cannot hand out a nonce that is already used or
// already in flight ("nonce too low", "replacement transaction underpriced").
// A send is retried on the next upstream like any request, so a transaction the first upstream
// accepted before its answer was lost (a 5xx or a reset after acceptance) reaches a second one,
// which answers "already known", or "nonce too low" once it is mined. Both mean the transaction
// is in, and the relay answers them with its hash (see settleSend) instead of failing the script.
// The log names upstreams by host only: a keyed provider URL carries the key in its path.
// STATS_MS sets the interval of the counters line (default one minute).
// Run it from this directory so "ethers" resolves from contracts/node_modules.
import http from "node:http";
import { Transaction, keccak256 } from "ethers";
const UPSTREAMS = (process.env.UPSTREAMS ?? [
  "https://sepolia.gateway.tenderly.co",
  "https://ethereum-sepolia.publicnode.com",
  "https://rpc.sepolia.ethpandaops.io",
  "https://eth-sepolia.api.onfinality.io/public",
  "https://gateway.tenderly.co/public/sepolia",
].join(",")).split(",");
const TIMEOUT_MS = 20_000, ATTEMPTS = 8, PORT = Number(process.env.PORT ?? 8555), STATS_MS = Number(process.env.STATS_MS ?? 60_000);
const PINNED = new Set(["eth_call", "eth_getBalance", "eth_getStorageAt", "eth_getCode", "eth_getTransactionCount"]);
let served = 0, retried = 0, cursor = 0, hwm = 0, nonceFloors = 0, pinned = 0, verified = 0, lagging = 0, duplicateSends = 0;
// A null result from these means the upstream does not have the pinned block (ethpandaops
// answers an unknown block with null instead of an error); it is retried like an error.
const NULL_IS_ERROR = new Set(["eth_estimateGas", "eth_call", "eth_getBalance", "eth_getStorageAt", "eth_getCode", "eth_getTransactionCount"]);
const highestNonce = new Map(); // sender (lowercase) -> highest nonce seen in a signed transaction
// Log names: the host, numbered when two upstreams share one, never the path or credentials.
const HOSTS = UPSTREAMS.map((u) => { try { return new URL(u).host; } catch { return "invalid-url"; } });
const LABELS = HOSTS.map((host, i) => (HOSTS.indexOf(host) !== HOSTS.lastIndexOf(host) ? `${host}#${i}` : host));
const counts = Object.fromEntries(LABELS.map((label) => [label, 0]));
const hex = (n) => "0x" + n.toString(16);
function pin(body) {
  try {
    const req = JSON.parse(body);
    if (hwm > 0 && !Array.isArray(req) && Array.isArray(req.params)) {
      if (PINNED.has(req.method)) {
        const last = req.params[req.params.length - 1];
        // "pending" stays on nonce reads, where it counts the mempool; on every other read it is
        // only a lagging node's view, the same as "latest".
        const floating = last === "latest" || (last === "pending" && req.method !== "eth_getTransactionCount");
        if (floating) { req.params[req.params.length - 1] = hex(hwm); pinned++; return JSON.stringify(req); }
      }
      // Gas estimates are deliberately NOT pinned (see forward): an estimate run in a mined
      // block's context under-prices and mis-judges the next block (warm storage, the per-block
      // mint cap keyed by block.number). They are verified against the upstream's head instead.
    }
    if (!Array.isArray(req) && req.method === "eth_sendRawTransaction" && typeof req.params?.[0] === "string") {
      const tx = Transaction.from(req.params[0]);
      const from = tx.from?.toLowerCase();
      if (from && tx.nonce > (highestNonce.get(from) ?? -1)) highestNonce.set(from, tx.nonce);
    }
  } catch {
    // Not JSON, or not a raw transaction: nothing to learn, forward the body as it is.
  }
  return body;
}
// Never report a transaction count below the nonces this relay has already forwarded.
function floorNonce(body, text) {
  try {
    const req = JSON.parse(body);
    if (Array.isArray(req) || req.method !== "eth_getTransactionCount") return text;
    const from = String(req.params?.[0] ?? "").toLowerCase();
    if (!highestNonce.has(from)) return text;
    const res = JSON.parse(text);
    if (!res || res.error || typeof res.result !== "string") return text;
    const floor = highestNonce.get(from) + 1;
    if (parseInt(res.result, 16) >= floor) return text;
    nonceFloors++;
    return JSON.stringify({ ...res, result: hex(floor) });
  } catch { return text; }
}
function learn(body, text) {
  try {
    const req = JSON.parse(body), res = JSON.parse(text);
    if (Array.isArray(req) || !res || res.error) return;
    let n = 0;
    if (req.method === "eth_blockNumber" && typeof res.result === "string") n = parseInt(res.result, 16);
    else if (req.method === "eth_getTransactionReceipt" && res.result?.blockNumber) n = parseInt(res.result.blockNumber, 16);
    else if (req.method === "eth_getBlockByNumber" && res.result?.number) n = parseInt(res.result.number, 16);
    if (n > hwm) hwm = n;
  } catch {
    // Not a parseable response: the high-water mark simply does not move.
  }
}
function methodOf(body) {
  try { const req = JSON.parse(body); return Array.isArray(req) ? null : req.method; } catch { return null; }
}
const UPSTREAM_ERROR = /"message":"(?:[^"]*(?:relay|upstream|internal|timeout|rate limit|header not found|block not found|unknown block|missing trie node|block is out of range|pruned|history unavailable|exceeds the range|too many results)[^"]*)"/i;
async function ask(upstream, payload) {
  const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429 || res.status >= 500) throw new Error(`upstream ${res.status}`);
  const text = await res.text();
  if (UPSTREAM_ERROR.test(text)) throw new Error("upstream error body");
  return text;
}
// A send the upstream refuses because it already has this transaction is answered with the
// hash, as a first send would have been. "nonce too low" alone could also mean another
// transaction took the nonce, so it counts only when the upstream knows this exact hash.
const DUPLICATE_SEND = /already known|known transaction|already imported/i;
const NONCE_USED = /nonce too low/i;
async function settleSend(upstream, body, text) {
  let req, res;
  try { req = JSON.parse(body); res = JSON.parse(text); } catch { return text; }
  const message = String(res?.error?.message ?? "");
  if (!res?.error || typeof req.params?.[0] !== "string") return text;
  const hash = keccak256(req.params[0]);
  if (!DUPLICATE_SEND.test(message)) {
    if (!NONCE_USED.test(message)) return text;
    const lookup = JSON.parse(await ask(upstream, JSON.stringify({ jsonrpc: "2.0", id: "relay-tx", method: "eth_getTransactionByHash", params: [hash] })));
    if (String(lookup?.result?.hash ?? "").toLowerCase() !== hash) return text;
  }
  duplicateSends++;
  return JSON.stringify({ jsonrpc: "2.0", id: req.id, result: hash });
}
async function forward(body) {
  const sent = pin(body);
  const method = methodOf(body);
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    // The cursor already moves on after every failure; adding the attempt number as well
    // skipped every other upstream, and with an even count only ever tried half of them.
    const index = cursor % UPSTREAMS.length;
    const upstream = UPSTREAMS[index];
    try {
      let text;
      if (method === "eth_estimateGas" && hwm > 0) {
        // An estimate must see the newest state (a deposit mined a second ago) in the NEXT
        // block's context (pending), which no block tag expresses. Public gateways balance each
        // HTTP request across nodes at different heights, so the estimate travels in one batch
        // with eth_blockNumber: the same node answers both, and an answer from a node still
        // below the high-water mark is discarded and asked elsewhere.
        const req = JSON.parse(body);
        const batch = JSON.stringify([{ jsonrpc: "2.0", id: "relay-head", method: "eth_blockNumber", params: [] }, req]);
        const answers = JSON.parse(await ask(upstream, batch));
        if (!Array.isArray(answers)) throw new Error("upstream rejected the batch");
        const head = parseInt(answers.find((r) => r.id === "relay-head")?.result ?? "0x0", 16);
        const estimate = answers.find((r) => r.id === req.id);
        if (!estimate) throw new Error("batch answer missing the estimate");
        if (head < hwm) { lagging++; throw new Error(`upstream head ${head} below the high-water mark ${hwm}`); }
        verified++;
        text = JSON.stringify(estimate);
      } else {
        text = await ask(upstream, sent);
        if (method === "eth_sendRawTransaction") text = await settleSend(upstream, body, text);
      }
      if (NULL_IS_ERROR.has(method) && /"result"\s*:\s*null/.test(text)) throw new Error("upstream returned null for a pinned read");
      counts[LABELS[index]]++;
      learn(body, text);
      return floorNonce(body, text);
    } catch (e) {
      lastErr = e; retried++;
      cursor = (cursor + 1) % UPSTREAMS.length;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try { const out = await forward(body); served++; res.writeHead(200, { "content-type": "application/json" }); res.end(out); }
    catch (e) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `relay: ${e.message}` } })); }
  });
}).listen(PORT, "127.0.0.1", function () { console.log(`relay on ${this.address().port} -> ${LABELS.join(" | ")}`); });
setInterval(() => console.log(`served ${served}, retried ${retried}, hwm ${hwm}, pinned ${pinned}, estimates verified ${verified}, lagging answers dropped ${lagging}, nonce floors applied ${nonceFloors}, duplicate sends settled ${duplicateSends}, per upstream ${JSON.stringify(counts)}`), STATS_MS);
