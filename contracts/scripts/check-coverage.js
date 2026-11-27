/* eslint-disable no-console */
// Enforces a minimum line and branch coverage threshold for the core contracts.
// Reads ./coverage/coverage-summary.json (produced by solidity-coverage) and
// exits non-zero if either metric falls below the configured threshold.
//
// Target thresholds: 95% line + 95% branch, on the global total (not per file).
// Tune via env vars COVERAGE_LINES / COVERAGE_BRANCHES if needed during ramp-up.
//
// The gate fails closed: a threshold that is not a number from 0 to 100, or a summary
// figure that is not a number (istanbul writes "Unknown" when nothing was measured), is a
// failure. A NaN on either side of `<` is false, so before this check both passed.

const fs = require("fs");
const path = require("path");

const SUMMARY_PATH = path.resolve(__dirname, "..", "coverage", "coverage-summary.json");
const DEFAULT_MIN = 95;

function readThreshold(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === "") return { value: DEFAULT_MIN };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return { problem: `${name}=${JSON.stringify(raw)} is not a percentage from 0 to 100` };
  }
  return { value };
}

/** Every reason the summary total fails the gate; an empty list is a pass. */
function coverageProblems(total, env = process.env) {
  if (!total || typeof total !== "object") return ["coverage-summary.json missing 'total' entry"];
  const problems = [];
  for (const [metric, label, envName] of [
    ["lines", "line", "COVERAGE_LINES"],
    ["branches", "branch", "COVERAGE_BRANCHES"],
  ]) {
    const min = readThreshold(env, envName);
    const pct = total[metric]?.pct;
    if (min.problem) problems.push(min.problem);
    if (typeof pct !== "number" || !Number.isFinite(pct)) {
      problems.push(`${label} coverage is ${JSON.stringify(pct)}, not a measured percentage`);
    } else if (min.value !== undefined && pct < min.value) {
      problems.push(`${label} coverage ${pct}% below ${min.value}%`);
    }
  }
  return problems;
}

function main() {
  if (!fs.existsSync(SUMMARY_PATH)) {
    console.error(`Coverage summary not found at ${SUMMARY_PATH}. Did 'hardhat coverage' run?`);
    process.exit(1);
  }
  const total = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8")).total;
  console.log(`Lines:    ${total?.lines?.pct}% (min ${process.env.COVERAGE_LINES ?? DEFAULT_MIN}%)`);
  console.log(`Branches: ${total?.branches?.pct}% (min ${process.env.COVERAGE_BRANCHES ?? DEFAULT_MIN}%)`);
  const problems = coverageProblems(total);
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

if (require.main === module) main();

module.exports = { coverageProblems };
