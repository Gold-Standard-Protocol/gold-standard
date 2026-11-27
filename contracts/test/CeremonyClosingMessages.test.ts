import { expect } from "chai";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HANDOVER_ORDER } from "../scripts/lib/governanceHandover";
import { POST_HANDOVER_VERIFICATION, REMAINING_CEREMONY_SCRIPTS, keyReminderApplies, keyReminderLines } from "../scripts/lib/keyHygiene";

/**
 * What the ceremony scripts print as they close: the reminder about the deployer key still
 * exported in the shell, and the pointer to the handover, which names one command and never a
 * list of calls to send by hand.
 */
describe("Ceremony closing messages (scripts/deploy.ts, scripts/transfer-governance.ts)", function () {
  const script = (name: string): string => readFileSync(resolve(__dirname, "..", "scripts", name), "utf8");

  describe("the deployer key reminder (scripts/lib/keyHygiene.ts)", function () {
    it("after the handover, says to unset the exported variables, delete the file and close the shell", function () {
      const text = keyReminderLines("handed-over").join("\n");
      expect(text).to.include("unset PRIVATE_KEY RPC_URL ETHERSCAN_API_KEY");
      expect(text).to.include("delete .env.mainnet");
      expect(text).to.include("close this shell");
      expect(text).to.include("Deleting the file alone leaves the key exported");
    });

    it("after the handover, puts the verification it names as the next step before the unset", function () {
      const text = keyReminderLines("handed-over").join("\n");
      const verification = text.indexOf(POST_HANDOVER_VERIFICATION);
      const passed = text.indexOf("Once it has passed");
      const unset = text.indexOf("unset PRIVATE_KEY");
      expect(verification).to.be.greaterThan(-1);
      expect(passed).to.be.greaterThan(verification);
      expect(unset).to.be.greaterThan(passed);
      // "Before anything else" alone, ahead of the verification, is the wording that stranded the operator.
      expect(text.slice(0, verification)).to.not.include("efore anything else");
      // The script prints the same command as its next step, directly above the reminder.
      const handover = script("transfer-governance.ts");
      expect(POST_HANDOVER_VERIFICATION).to.equal("EXPECT_GOVERNANCE_TRANSFERRED=1 npx hardhat run scripts/verify-deployment.ts");
      expect(handover.indexOf("${POST_HANDOVER_VERIFICATION} --network")).to.be.greaterThan(-1);
      expect(handover.indexOf('keyReminderLines("handed-over")')).to.be.greaterThan(handover.indexOf("${POST_HANDOVER_VERIFICATION} --network"));
    });

    it("after the deploy, names the ceremony steps that still run from the shell and forbids the rest", function () {
      const text = keyReminderLines("deployed").join("\n");
      expect(text).to.include("still exports PRIVATE_KEY");
      expect(REMAINING_CEREMONY_SCRIPTS).to.deep.equal(["scripts/verify-deployment.ts", "scripts/verify-etherscan.ts", "scripts/transfer-governance.ts"]);
      const positions = REMAINING_CEREMONY_SCRIPTS.map((name) => text.lastIndexOf(name));
      for (const position of positions) expect(position).to.be.greaterThan(-1);
      expect([...positions].sort((a, b) => a - b)).to.deep.equal(positions);
      expect(text).to.include("run only");
      expect(text).to.include("No installs, no builds, nothing else");
      // The old wording forbade the two verification steps the handover depends on.
      expect(text).to.not.include("no other scripts");
      expect(text).to.not.include("Run nothing else");
    });

    it("belongs on mainnet and under REQUIRE_PREFLIGHT_RECORD=1 only, in the handover as in the deploy", function () {
      expect(keyReminderApplies(1, undefined)).to.equal(true);
      expect(keyReminderApplies(11155111, undefined)).to.equal(false);
      expect(keyReminderApplies(31337, undefined)).to.equal(false);
      expect(keyReminderApplies(31337, "1")).to.equal(true);
      expect(keyReminderApplies(11155111, "0")).to.equal(false);
      const handover = script("transfer-governance.ts");
      expect(handover).to.match(/if \(keyReminderApplies\(Number\(network\.chainId\), process\.env\.REQUIRE_PREFLIGHT_RECORD\)\) \{[^}]*keyReminderLines\("handed-over"\)/);
      expect(script("deploy.ts")).to.include('if (mandatory) console.log(`\\n${keyReminderLines("deployed").join("\\n")}`)');
    });

    it("names variables and never prints a value", function () {
      const source = script("lib/keyHygiene.ts");
      expect(source).to.not.include("process.env");
      for (const stage of ["deployed", "handed-over"] as const) {
        for (const line of keyReminderLines(stage)) expect(line).to.not.match(/0x[0-9a-fA-F]{8,}|https?:\/\//);
      }
    });

    it("is printed by the deploy and by the handover", function () {
      expect(script("deploy.ts")).to.include('keyReminderLines("deployed")');
      expect(script("transfer-governance.ts")).to.include('keyReminderLines("handed-over")');
    });
  });

  describe("the handover pointer deploy.ts prints", function () {
    const deploy = script("deploy.ts");

    it("gives the one command and lists no call to send by hand", function () {
      expect(deploy).to.include("CONFIRM=YES npx hardhat run scripts/transfer-governance.ts --network ${network.name}");
      expect(deploy).to.not.match(/console\.log\("\s*await \w+\.transferGovernance/);
      expect(deploy).to.not.include("renounceRole(DEFAULT_ADMIN_ROLE, deployer)");
      expect(deploy).to.include("Do not send these calls by hand");
    });

    it("names the GoldGovernance wrapper among what is handed over, as the handover itself does", function () {
      expect(HANDOVER_ORDER).to.include("governance");
      expect(deploy).to.include("the GoldGovernance wrapper");
      // Every contract the handover transfers is named in the printed summary.
      for (const name of ["stablecoin", "oracle", "vault", "stability module", "surplus buffer", "stability pool", "reserve", "silo factory"]) {
        expect(deploy, name).to.include(name);
      }
      expect(HANDOVER_ORDER).to.have.length(9);
    });
  });

  describe("the closing instruction of set-origination-fee.ts", function () {
    it("names the network the run used, never a literal placeholder", function () {
      const source = script("set-origination-fee.ts");
      const code = source.slice(source.indexOf("*/"));
      expect(code).to.not.include("<net>");
      expect(code).to.include("scripts/refresh-deployment-snapshot.ts --network ${networkName}");
      expect(code).to.include("console.log(summarise(outcome, network.name));");
    });
  });
});
