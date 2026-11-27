/* eslint-disable */
import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import axios from 'axios';

declare global {
  // Shared with global-teardown through globalThis.
  var __API_CHILD__: ChildProcess | undefined;
}

const port = process.env.PORT ?? '3399';
const probe = `/trpc/vaultsRouter.owners?input=${encodeURIComponent('{"chainId":11155111}')}`;

// Boots the BUILT api (the e2e target depends on api:build) on its own port so the suite
// never touches a dev server. Redis must be reachable, as for any api process.
module.exports = async function () {
  const entry = resolve(__dirname, '../../../../dist/apps/api/main.js');
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));

  const deadline = Date.now() + 30_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try {
      const res = await axios.get(`http://localhost:${port}${probe}`, { validateStatus: () => true, timeout: 2_000 });
      ready = res.status < 500;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error(`api did not answer on port ${port} within 30s:\n${output}`);
  }
  globalThis.__API_CHILD__ = child;
};
