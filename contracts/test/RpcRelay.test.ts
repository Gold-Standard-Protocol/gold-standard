import { expect } from "chai";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { Wallet, keccak256 } from "ethers";

/**
 * tools/rpc-relay.mjs, run as the operator runs it, against fake upstreams on loopback.
 * A send whose first upstream accepted it and then failed is re-sent to the next one, whose
 * duplicate answer must come back as the transaction hash; and no upstream key reaches the log.
 */
describe("rpc-relay", function () {
  this.timeout(20_000);

  type Answer = { status?: number; body?: unknown };
  type Handler = (method: string, params: unknown[]) => Answer;
  const KEY = "SECRETKEY0123456789";
  const servers: http.Server[] = [];
  const relays: ChildProcessWithoutNullStreams[] = [];

  async function upstream(handler: Handler): Promise<string> {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const request = JSON.parse(body) as { id: unknown; method: string; params: unknown[] };
        const answer = handler(request.method, request.params);
        res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(answer.body as object) }));
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/${KEY}`;
  }

  /** Starts the relay over `upstreams`; resolves with its port and a reader for everything it printed. */
  async function relay(upstreams: string[]): Promise<{ port: number; output: () => string }> {
    const child = spawn(process.execPath, ["tools/rpc-relay.mjs"], {
      cwd: resolve(__dirname, ".."),
      env: { ...process.env, UPSTREAMS: upstreams.join(","), PORT: "0", STATS_MS: "200" },
    });
    relays.push(child);
    let printed = "";
    child.stdout.on("data", (c) => (printed += c));
    child.stderr.on("data", (c) => (printed += c));
    const port = await new Promise<number>((done, fail) => {
      const timer = setInterval(() => {
        const match = /relay on (\d+)/.exec(printed);
        if (match) { clearInterval(timer); done(Number(match[1])); }
      }, 20);
      child.on("exit", (code) => { clearInterval(timer); fail(new Error(`relay exited ${code}: ${printed}`)); });
    });
    return { port, output: () => printed };
  }

  async function call(port: number, method: string, params: unknown[]): Promise<{ id: unknown; result?: unknown; error?: { message: string } }> {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method, params }),
    });
    return res.json() as Promise<{ id: unknown; result?: unknown; error?: { message: string } }>;
  }

  async function signedTransaction(): Promise<string> {
    const wallet = Wallet.createRandom();
    return wallet.signTransaction({ chainId: 11155111, nonce: 7, to: wallet.address, gasLimit: 21_000, maxFeePerGas: 2_000_000_000, maxPriorityFeePerGas: 1_000_000 });
  }

  /** The first upstream takes the transaction and then fails the HTTP exchange, as a gateway 503 after acceptance does. */
  const acceptedThenFailed: Handler = () => ({ status: 503, body: { error: { code: -32000, message: "service unavailable" } } });

  afterEach(async function () {
    for (const child of relays.splice(0)) child.kill();
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  it("answers a re-sent transaction the next upstream already holds with its hash", async function () {
    const raw = await signedTransaction();
    const second = await upstream((method) =>
      method === "eth_sendRawTransaction" ? { body: { error: { code: -32000, message: "already known" } } } : { body: { result: null } }
    );
    const { port } = await relay([await upstream(acceptedThenFailed), second]);
    const answer = await call(port, "eth_sendRawTransaction", [raw]);
    expect(answer.error).to.equal(undefined);
    expect(answer.result).to.equal(keccak256(raw));
    expect(answer.id).to.equal(42);
  });

  it("answers 'nonce too low' with the hash when the upstream has this exact transaction", async function () {
    const raw = await signedTransaction();
    const second = await upstream((method, params) => {
      if (method === "eth_sendRawTransaction") return { body: { error: { code: -32000, message: "nonce too low: next nonce 8, tx nonce 7" } } };
      if (method === "eth_getTransactionByHash") return { body: { result: { hash: params[0], blockNumber: "0x10" } } };
      return { body: { result: null } };
    });
    const { port } = await relay([await upstream(acceptedThenFailed), second]);
    const answer = await call(port, "eth_sendRawTransaction", [raw]);
    expect(answer.result).to.equal(keccak256(raw));
  });

  it("passes 'nonce too low' through when another transaction took the nonce", async function () {
    const raw = await signedTransaction();
    const second = await upstream((method) => {
      if (method === "eth_sendRawTransaction") return { body: { error: { code: -32000, message: "nonce too low: next nonce 8, tx nonce 7" } } };
      return { body: { result: null } };
    });
    const { port } = await relay([await upstream(acceptedThenFailed), second]);
    const answer = await call(port, "eth_sendRawTransaction", [raw]);
    expect(answer.result).to.equal(undefined);
    expect(answer.error?.message).to.match(/nonce too low/);
  });

  it("never prints an upstream's path, where a provider key lives", async function () {
    const { port, output } = await relay([await upstream(() => ({ body: { result: "0x10" } }))]);
    await call(port, "eth_blockNumber", []);
    await new Promise((done) => setTimeout(done, 500)); // past at least one stats line
    expect(output()).to.match(/served \d+/);
    expect(output()).to.include("127.0.0.1:");
    expect(output()).not.to.include(KEY);
  });
});
