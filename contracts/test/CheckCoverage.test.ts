import { expect } from "chai";

type CoverageTotal = Record<string, { pct?: unknown } | undefined>;
// A CommonJS script run directly by contracts-coverage.yml, so it has no type declarations.
const { coverageProblems } = require("../scripts/check-coverage.js") as {
  coverageProblems: (total: CoverageTotal | undefined, env: Record<string, string | undefined>) => string[];
};

const measured = (lines: unknown, branches: unknown): CoverageTotal => ({ lines: { pct: lines }, branches: { pct: branches } });

/**
 * The coverage gate (scripts/check-coverage.js) fails closed: a NaN on either side of `<`
 * compares false, so a bad threshold or an "Unknown" figure used to pass the gate.
 */
describe("Coverage gate (scripts/check-coverage.js)", function () {
  it("passes figures at or above the default 95% thresholds", function () {
    expect(coverageProblems(measured(98.9, 95), {})).to.deep.equal([]);
  });

  it("fails a figure below its threshold", function () {
    expect(coverageProblems(measured(94.99, 98), {})).to.deep.equal(["line coverage 94.99% below 95%"]);
  });

  it("fails an istanbul 'Unknown' figure or a missing one instead of passing it", function () {
    expect(coverageProblems(measured("Unknown", 99), {})).to.deep.equal(['line coverage is "Unknown", not a measured percentage']);
    expect(coverageProblems({ lines: { pct: 99 } }, {})).to.deep.equal(["branch coverage is undefined, not a measured percentage"]);
  });

  it("fails a threshold that is not a percentage instead of comparing against NaN", function () {
    expect(coverageProblems(measured(10, 10), { COVERAGE_LINES: "ninety" })).to.deep.equal([
      'COVERAGE_LINES="ninety" is not a percentage from 0 to 100',
      "branch coverage 10% below 95%",
    ]);
    expect(coverageProblems(measured(99, 99), { COVERAGE_BRANCHES: "150" })).to.deep.equal([
      'COVERAGE_BRANCHES="150" is not a percentage from 0 to 100',
    ]);
  });

  it("honours a valid threshold from the environment and treats an empty one as the default", function () {
    expect(coverageProblems(measured(91, 91), { COVERAGE_LINES: "90", COVERAGE_BRANCHES: "90" })).to.deep.equal([]);
    expect(coverageProblems(measured(91, 99), { COVERAGE_LINES: "" })).to.deep.equal(["line coverage 91% below 95%"]);
  });

  it("fails a summary with no total", function () {
    expect(coverageProblems(undefined, {})).to.deep.equal(["coverage-summary.json missing 'total' entry"]);
  });
});
