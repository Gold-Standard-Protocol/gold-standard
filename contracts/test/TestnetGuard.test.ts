import { expect } from "chai";
import { refuseOnMainnet } from "../scripts/lib/testnetGuard";

/**
 * The guard the testnet-only scripts (walk-testnet-price.ts, ramp-testnet-ceiling.ts,
 * set-testnet-mint-cap.ts) run first. It reads the chain id the RPC reports, so a network
 * entry with another name that points at chain 1 is refused as well.
 */
describe("Testnet-only guard (scripts/lib/testnetGuard.ts)", function () {
  const refusal = "Refusing on mainnet: use governance.";

  it("refuses chain id 1 whatever the network entry is called", function () {
    expect(() => refuseOnMainnet(1n, "prod", refusal)).to.throw(refusal);
    expect(() => refuseOnMainnet(1, "sepolia", refusal)).to.throw(refusal);
  });

  it("refuses a network entry named mainnet even if its RPC reports another chain", function () {
    expect(() => refuseOnMainnet(31337n, "mainnet", refusal)).to.throw(refusal);
  });

  it("lets a testnet or a local chain through", function () {
    expect(() => refuseOnMainnet(11155111n, "sepolia", refusal)).not.to.throw();
    expect(() => refuseOnMainnet(31337n, "localhost", refusal)).not.to.throw();
  });
});
