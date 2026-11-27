module.exports = {
  skipFiles: ["test/mocks/MockAggregatorV3.sol", "test/mocks/MockERC20.sol"],
  // nonReentrant counts as a branch on every guarded function. Its untaken arm is the
  // re-entry revert, which only an attacking token could reach, so it is excluded from
  // the branch denominator rather than left as permanent noise under the coverage gate.
  modifierWhitelist: ["nonReentrant"],
  // json-summary is required by scripts/check-coverage.js (coverage:check gate).
  istanbulReporter: ["html", "lcov", "text", "json-summary"],
  configureYulOptimizer: true,
  mocha: {
    timeout: 120000,
  },
};
