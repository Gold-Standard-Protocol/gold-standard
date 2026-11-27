import { expect } from "chai";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(__dirname, "..");

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/**
 * Hardhat runs ts-node in transpile-only mode, so a launch script
 * that calls a renamed contract method or passes the wrong arguments only failed at the point
 * of use, part way through a ceremony. tsconfig.json now covers scripts/ and tools/, and
 * contracts-ci.yml runs `npm run typecheck` after the compile has generated typechain-types.
 */
describe("Script type-check scope (tsconfig.json, contracts-ci.yml)", function () {
  it("puts every TypeScript file under scripts/ and tools/ in the type-checked program", function () {
    const parsed = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.json"), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    });
    if (!parsed) throw new Error("tsconfig.json did not parse");
    const covered = new Set(parsed.fileNames.map((f) => resolve(f)));
    const scripts = [...tsFilesUnder(join(ROOT, "scripts")), ...tsFilesUnder(join(ROOT, "tools"))];
    expect(scripts).to.include(join(ROOT, "scripts", "deploy.ts"));
    expect(scripts.filter((f) => !covered.has(resolve(f))).map((f) => f.slice(ROOT.length + 1))).to.deep.equal([]);
  });

  it("has a typecheck script and runs it in contracts CI after the compile", function () {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).to.equal("tsc --noEmit -p .");
    const workflow = readFileSync(join(ROOT, "..", ".github", "workflows", "contracts-ci.yml"), "utf8");
    const compile = workflow.indexOf("run: npm run compile");
    const typecheck = workflow.indexOf("run: npm run typecheck");
    expect(compile).to.be.greaterThan(-1);
    expect(typecheck).to.be.greaterThan(compile);
  });
});
