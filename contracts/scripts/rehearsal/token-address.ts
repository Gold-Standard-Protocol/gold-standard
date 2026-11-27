/**
 * The token's address, proven with the launch's own numbers before the ceremony.
 *
 * The ceremony's first transaction creates the GoldStablecoinDeployer, and the token's address
 * follows from that contract's address, GSUSD_SALT and the token's creation code. A rehearsal
 * deploys from a development account, so its deployer contract and its token stand elsewhere.
 * This script stands in the launch deployer's place instead: on a fresh fork it sends, as
 * TOKEN_ADDRESS_DEPLOYER and from that account's own nonce, the two transactions the ceremony
 * sends, and checks that the token lands on GSUSD_ADDRESS with that account as its only admin.
 * Everything is undone at the end, so the fork is left as it was.
 *
 *   TOKEN_ADDRESS_DEPLOYER=<launch deployer> GSUSD_SALT=… GSUSD_ADDRESS=… \
 *     npx hardhat run --no-compile scripts/rehearsal/token-address.ts --network localhost
 */
import { artifacts, ethers } from "hardhat";
import { getAddress } from "ethers";
import { describeError } from "../lib/redact";
import { parseStablecoinAddressEnv, predictStablecoinAddress } from "../lib/stablecoinAddress";

async function main(): Promise<void> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 31337) throw new Error(`This rehearsal impersonates an account and runs on a local fork only; the chain id is ${chainId}.`);
  const deployer = getAddress((process.env.TOKEN_ADDRESS_DEPLOYER ?? "").trim());
  const { plan, findings } = parseStablecoinAddressEnv(process.env, true);
  if (!plan || plan.expected === undefined) throw new Error(findings.map((f) => `${f.name}: ${f.detail}`).join("\n"));
  const expected = plan.expected;

  const lines: string[] = [];
  let failed = 0;
  const check = (name: string, ok: boolean, detail: string): void => {
    lines.push(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
    if (!ok) failed++;
  };
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  const snapshot: string = await ethers.provider.send("evm_snapshot", []);
  try {
    const nonce = await ethers.provider.getTransactionCount(deployer);
    const initCodeHash = ethers.keccak256((await artifacts.readArtifact("GoldStablecoin")).bytecode);
    const predicted = predictStablecoinAddress(deployer, nonce, plan.salt, initCodeHash);
    check("computed", same(predicted.token, expected), `deployer ${deployer} at nonce ${nonce}: deployer contract ${predicted.deployerContract}, token ${predicted.token}; GSUSD_ADDRESS ${expected}`);
    check("unused", (await ethers.provider.getCode(expected)) === "0x" && (await ethers.provider.getCode(predicted.deployerContract)) === "0x", "nothing stands at either address yet");

    await ethers.provider.send("hardhat_setBalance", [deployer, "0x56BC75E2D63100000"]);
    const signer = await ethers.getImpersonatedSigner(deployer);
    const tokenDeployer = await (await ethers.getContractFactory("GoldStablecoinDeployer", signer)).deploy();
    await tokenDeployer.waitForDeployment();
    const deployerContract = await tokenDeployer.getAddress();
    check("deployer-contract", same(deployerContract, predicted.deployerContract), `created at ${deployerContract}`);
    check("contract-agrees", same(await tokenDeployer.predict(plan.salt), expected) && (await tokenDeployer.initCodeHash()) === initCodeHash, `predict(salt) is ${await tokenDeployer.predict(plan.salt)}, creation code hash ${initCodeHash}`);

    const receipt = await (await tokenDeployer.deploy(plan.salt)).wait();
    const created: string = await tokenDeployer.token();
    check("token", same(created, expected), `created at ${created} (${receipt?.gasUsed} gas)`);
    const token = await ethers.getContractAt("GoldStablecoin", created);
    const admin = await token.DEFAULT_ADMIN_ROLE();
    const admins = Number(await token.getRoleMemberCount(admin));
    check("admin", admins === 1 && same(await token.getRoleMember(admin, 0), deployer) && !(await token.hasRole(admin, deployerContract)), `${admins} admin, ${await token.getRoleMember(admin, 0)}; the deployer contract holds none`);
    check("token-is-gsusd", (await token.symbol()) === "GSUSD" && (await token.totalSupply()) === 0n && Number(await token.getRoleMemberCount(await token.MINTER_ROLE())) === 0, `${await token.name()} (${await token.symbol()}), supply 0, no minter yet`);
    const stranger = await ethers.getImpersonatedSigner("0x000000000000000000000000000000000000dEaD");
    await ethers.provider.send("hardhat_setBalance", [stranger.address, "0x56BC75E2D63100000"]);
    const refused = await tokenDeployer.connect(stranger).deploy.staticCall(plan.salt).then(() => false, () => true);
    const again = await tokenDeployer.deploy.staticCall(ethers.ZeroHash).then(() => false, () => true);
    check("once-and-owner-only", refused && again, "another account is refused, and so is a second token");
  } finally {
    await ethers.provider.send("evm_revert", [snapshot]);
  }
  console.log(lines.join("\n"));
  console.log(`\nToken address rehearsal: ${lines.length - failed}/${lines.length} checks passed`);
  if (failed > 0) throw new Error("The token would not stand at GSUSD_ADDRESS. Do not deploy.");
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
