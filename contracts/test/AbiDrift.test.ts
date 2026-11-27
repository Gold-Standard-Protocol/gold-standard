import { expect } from "chai";
import { readFileSync } from "fs";
import { artifacts } from "hardhat";
import { resolve } from "path";

/**
 * libs/constants/src/lib/abis/*.ts is what the dapp and the keeper call the contracts with.
 * tools/sync-abis.mjs regenerates those files from the compiled artifacts, and its own test
 * exercises the tool on a temporary directory; nothing compared the committed files with
 * the contracts in this tree before this test. A forgotten sync after a
 * Solidity change would then ship a client that cannot see a new revert reason or event.
 */
describe("ABI drift between libs/constants and the compiled artifacts", function () {
  const root = resolve(__dirname, "..", "..");
  const tool = readFileSync(resolve(root, "tools/sync-abis.mjs"), "utf8");
  // The single source of truth is the tool's own target list; read it from the source rather
  // than importing the ES module into the CommonJS test runner.
  const targets = [...tool.matchAll(/^\s*\["(\w+)",\s*"[^"]+",\s*"(\w+)"\],?\s*$/gm)].map((m) => ({
    contract: m[1],
    exportName: m[2],
  }));

  it("finds the tool's target list", function () {
    expect(targets.map((t) => t.contract)).to.include.members(["GoldVault", "GoldOracle", "StabilityPool", "VaultRegistry"]);
  });

  for (const { contract, exportName } of targets) {
    it(`${exportName} matches the compiled ${contract}`, async function () {
      // The tool writes `${contract}.ts` (GoldVault.ts); the export name differs only in case,
      // which a case-insensitive filesystem hides and the Linux CI runner does not.
      const file = resolve(root, "libs/constants/src/lib/abis", `${contract}.ts`);
      const source = readFileSync(file, "utf8");
      const body = source.replace(new RegExp(`^export const ${exportName} = `), "").replace(/\s*as const;?\s*$/, "");
      // The file is a TypeScript literal in the hand-written style; as a JavaScript expression
      // it evaluates to the same array.
      const committed = new Function(`return ${body}`)() as unknown[];
      const compiled = (await artifacts.readArtifact(contract)).abi as unknown[];
      expect(committed, `${file} is stale: run node tools/sync-abis.mjs after npx hardhat compile`).to.deep.equal(compiled);
    });
  }
});
