import { defineConfig, type Plugin } from 'vitest/config';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';
import {
  namesTargetChain,
  resolveTargetChainValue,
  unnamedTargetChainMessage,
  unsupportedTargetChainMessage,
} from '../../libs/constants/src/lib/targetChainValue';
import { buildEnvRefusal, checkBuildEnv, ledgerCodeProblems, type BuildEnv } from '../../libs/constants/src/lib/buildEnv';
import { sitemapForBuild } from '../../libs/constants/src/lib/sitemap';
import { tokenListForBuild, tokenListText } from '../../libs/constants/src/lib/tokenList';
import { copyBrandFiles } from './src/build/brandFiles';

/**
 * The end-to-end wallet (src/app/e2eWallet.ts) may never ship. A build in e2e mode, or a
 * build whose environment carries VITE_E2E_WALLET from any .env file, fails here rather
 * than producing a bundle that connects visitors to a test account.
 */
function refuseE2EInBuilds(): Plugin {
  return {
    name: 'goldstandard:refuse-e2e-in-builds',
    configResolved(config) {
      if (config.command !== 'build') return;
      if (config.mode === 'e2e') throw new Error('Refusing to build the dapp in e2e mode: that mode is for the local end-to-end suite only.');
      if (config.env['VITE_E2E_WALLET']) {
        throw new Error('Refusing to build the dapp with VITE_E2E_WALLET set: remove it from the environment and .env files.');
      }
    },
  };
}

/**
 * The target chain parser in libs/constants only runs when a
 * bundle loads, so an unsupported VITE_TARGET_CHAIN_ID from the environment or any .env file
 * fails the build here instead of shipping a bundle that throws on load. It checks the same
 * table as the parser, imported by relative path because this config loads without the
 * @goldstandard/* path aliases. The refusal waits for buildStart, which only a real build
 * reaches: Nx resolves this config with command 'build' to infer its targets, so a refusal in
 * configResolved would stop every nx command on a checkout whose .env file holds a bad value.
 * A build must also name its chain: `vite build` makes a production bundle in every mode, and
 * the unset fallback, or a misspelt variable name, would otherwise ship the Sepolia frontend
 * from a mainnet release. Only the dev server and tests fall back to Sepolia.
 *
 * The same hook then checks the rest of the VITE_* environment:
 * a mainnet bundle is pinned to IPFS and named by an ENS content hash, so a missing RPC or API
 * URL, an unfilled "<fill in: ...>" placeholder, a contract address that is absent or malformed,
 * a token override that is not mainnet PAXG or XAUT, or a developer's .env.local must stop the
 * build instead of producing a page that is blank, rate limited or pointed at Sepolia values.
 */
function refuseUnsupportedTargetChainInBuilds(): Plugin {
  let raw: string | undefined;
  let env: BuildEnv = {};
  let hasEnvLocalFile = false;
  let warn: (message: string) => void = () => undefined;
  return {
    name: 'goldstandard:refuse-unsupported-target-chain-in-builds',
    apply: 'build',
    configResolved(config) {
      const configured: unknown = config.env['VITE_TARGET_CHAIN_ID'];
      raw = configured === undefined ? undefined : String(configured);
      env = viteVariables(config.env);
      hasEnvLocalFile = config.envDir !== false && existsSync(join(config.envDir, '.env.local'));
      warn = (message) => config.logger.warn(message);
    },
    buildStart() {
      const chainId = resolveTargetChainValue(raw);
      if (chainId === undefined) {
        throw new Error(`Refusing to build the dapp: ${unsupportedTargetChainMessage(raw ?? '')}`);
      }
      if (!namesTargetChain(raw)) {
        throw new Error(`Refusing to build the dapp: ${unnamedTargetChainMessage()}`);
      }
      // With the chain known, the rest of the
      // environment is judged in one pass by libs/constants/src/lib/buildEnv.ts, which also
      // holds the Sepolia PAXG rule. Every problem is listed in
      // one refusal, so a mainnet release is not rebuilt once per missing variable.
      const report = checkBuildEnv({ chainId, env, hasEnvLocalFile });
      report.warnings.forEach((warning) => warn(`The dapp build: ${warning}`));
      if (report.problems.length > 0) throw new Error(buildEnvRefusal(report.problems));
    },
  };
}

/**
 * A build without VITE_LEDGER_ENABLED=true must not carry the ledger page: not as a route and
 * not as a chunk that can be fetched by name. The page sits behind a build time constant, and
 * this hook reads the finished bundle to hold that true: a ledger chunk in a build with the
 * flag off stops the build instead of shipping unreleased copy.
 */
function refuseLedgerCodeInOffBuilds(): Plugin {
  let env: BuildEnv = {};
  return {
    name: 'goldstandard:refuse-ledger-code-in-off-builds',
    apply: 'build',
    configResolved(config) {
      env = viteVariables(config.env);
    },
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).map((file) => ({ fileName: file.fileName, code: file.type === 'chunk' ? file.code : '' }));
      const problems = ledgerCodeProblems(env, files);
      if (problems.length > 0) this.error(buildEnvRefusal(problems));
    },
  };
}

/**
 * The day of the commit a bundle was built from, as YYYY-MM-DD, or undefined without git.
 * It dates the sitemap, and comes from the commit and not the clock so that two builds of
 * one commit are the same files. A build server without git sets VITE_BUILD_DATE itself.
 */
function buildDay(): string | undefined {
  try {
    return execSync('git log -1 --format=%cs HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * public/sitemap.xml lists the routes every build has. The built copy also carries the day
 * of the commit, and the ledger page when the bundle has it (libs/constants/src/lib/sitemap.ts).
 */
function finishSitemap(): Plugin {
  let outDir = '';
  let env: BuildEnv = {};
  return {
    name: 'goldstandard:finish-sitemap',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      env = viteVariables(config.env);
    },
    writeBundle() {
      const file = join(outDir, 'sitemap.xml');
      if (!existsSync(file)) this.error('The dapp build has no sitemap.xml to finish: public/sitemap.xml is missing.');
      const built = sitemapForBuild(readFileSync(file, 'utf8'), {
        lastModified: env['VITE_BUILD_DATE'] ?? buildDay(),
        ledgerEnabled: env['VITE_LEDGER_ENABLED'] === 'true',
      });
      writeFileSync(file, built);
    },
  };
}

/**
 * What a build publishes about the token beside the bundle: the official marks under /brand/
 * (copied from the repository's brand folder, the one source) and, in a mainnet build,
 * /tokenlist.json with the GSUSD address the build was configured with
 * (libs/constants/src/lib/tokenList.ts). Other builds publish no list: their token is a test
 * deployment nobody should import.
 */
function publishTokenFiles(): Plugin {
  let outDir = '';
  let env: BuildEnv = {};
  return {
    name: 'goldstandard:publish-token-files',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      env = viteVariables(config.env);
    },
    writeBundle() {
      try {
        copyBrandFiles(outDir);
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
      const chainId = Number(env['VITE_TARGET_CHAIN_ID']);
      const list = tokenListForBuild({
        chainId,
        gsusd: env['VITE_GUSD_ADDRESS']?.trim(),
        day: env['VITE_BUILD_DATE'] ?? buildDay(),
      });
      if (list !== undefined) writeFileSync(join(outDir, 'tokenlist.json'), tokenListText(list));
      else if (chainId === 1) this.warn('No tokenlist.json was written: the build has no commit day. Set VITE_BUILD_DATE=YYYY-MM-DD.');
    },
  };
}

/** The VITE_* values Vite loaded from the process environment and the .env files, as text. */
function viteVariables(loaded: Readonly<Record<string, unknown>>): BuildEnv {
  return Object.fromEntries(
    Object.entries(loaded)
      .filter(([key]) => key.startsWith('VITE_'))
      .map(([key, value]) => [key, value === undefined ? undefined : String(value)])
  );
}

/**
 * The commit a bundle was built from, shown in the footer so a visitor can match the page
 * against the published source. A build server without git sets VITE_BUILD_COMMIT itself.
 */
function buildCommit(): string {
  try {
    return execSync('git rev-parse --short=10 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}
process.env['VITE_BUILD_COMMIT'] ??= buildCommit();

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/dapp',
  server: {
    port: 4200,
    host: 'localhost',
  },
  preview: {
    port: 4300,
    host: 'localhost',
  },
  plugins: [
    refuseE2EInBuilds(),
    refuseUnsupportedTargetChainInBuilds(),
    refuseLedgerCodeInOffBuilds(),
    finishSitemap(),
    publishTokenFiles(),
    react(),
    nxViteTsPaths(),
    nxCopyAssetsPlugin(['*.md']),
  ],
  // Buffer and process are shimmed in src/polyfills.ts; the bare `global` identifier
  // some wallet libraries reference is rewritten at build time.
  define: {
    global: 'globalThis',
  },
  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },
  build: {
    outDir: '../../dist/apps/dapp',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  test: {
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/dapp',
      provider: 'v8',
    },
  },
});
