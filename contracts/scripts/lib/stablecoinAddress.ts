/**
 * The address GSUSD is created at. The ceremony's first transaction creates a
 * GoldStablecoinDeployer, and that contract creates the token with CREATE2, so the token's
 * address follows from three things known before anything is sent: the deployer's address
 * and nonce (which fix the deployer contract's address), a salt, and the hash of the
 * token's creation code. GSUSD_SALT and GSUSD_ADDRESS name the salt and the address it is
 * meant to give; the preflight computes the address and deploy.ts asks the deployer
 * contract itself before the token is created, and both refuse a pair that does not agree.
 *
 * A salt is found off chain, with no key and no transaction:
 *   cast create2 --deployer <deployer contract> --init-code-hash <hash> --starts-with … --ends-with … --case-sensitive
 * Any change to the deployer's address or nonce, or to GoldStablecoin's creation code,
 * changes the address: the salt is then found again.
 */
import { getAddress, getCreate2Address, getCreateAddress, ZeroHash } from "ethers";
import { fail, pass } from "./findings";
import type { Finding } from "./findings";

export interface StablecoinAddressPlan {
  /** The CREATE2 salt, 32 bytes. Zero when none was asked for. */
  salt: string;
  /** The address the salt is meant to give; undefined when none was asked for. */
  expected: string | undefined;
}

const SALT = /^0x[0-9a-fA-F]{64}$/;

/**
 * GSUSD_SALT and GSUSD_ADDRESS from the environment: both, or neither. `mandatory` (mainnet)
 * refuses neither, since the launch fixes the token's address in advance.
 */
export function parseStablecoinAddressEnv(env: NodeJS.ProcessEnv, mandatory: boolean): { plan?: StablecoinAddressPlan; findings: Finding[] } {
  const salt = (env.GSUSD_SALT ?? "").trim();
  const address = (env.GSUSD_ADDRESS ?? "").trim();
  if (salt === "" && address === "") {
    if (mandatory) return { findings: [fail("env:GSUSD_ADDRESS", "GSUSD_SALT and GSUSD_ADDRESS are unset; the mainnet launch creates GSUSD at an address fixed in advance")] };
    return { plan: { salt: ZeroHash, expected: undefined }, findings: [] };
  }
  const findings: Finding[] = [];
  if (salt === "") findings.push(fail("env:GSUSD_SALT", "missing; GSUSD_ADDRESS is set, and the salt is what gives that address"));
  else if (!SALT.test(salt)) findings.push(fail("env:GSUSD_SALT", "is not a 32 byte hex value (0x and 64 hex digits)"));
  let expected: string | undefined;
  if (address === "") findings.push(fail("env:GSUSD_ADDRESS", "missing; GSUSD_SALT is set, and the ceremony checks the address it gives against this one"));
  else {
    try {
      expected = getAddress(address);
    } catch {
      findings.push(fail("env:GSUSD_ADDRESS", "is not an address, or its capital letters do not match its checksum"));
    }
  }
  if (findings.length > 0 || expected === undefined) return { findings };
  return { plan: { salt: salt.toLowerCase(), expected }, findings: [] };
}

/** Where the deployer contract and the token stand when the deployer's next transaction, at `nonce`, creates the deployer contract. */
export function predictStablecoinAddress(deployer: string, nonce: number, salt: string, initCodeHash: string): { deployerContract: string; token: string } {
  const deployerContract = getCreateAddress({ from: deployer, nonce });
  return { deployerContract, token: getCreate2Address(deployerContract, salt, initCodeHash) };
}

/** The plan against the address it gives, before anything is sent. */
export function stablecoinAddressFindings(plan: StablecoinAddressPlan, deployer: string, nonce: number, initCodeHash: string): Finding[] {
  const { deployerContract, token } = predictStablecoinAddress(deployer, nonce, plan.salt, initCodeHash);
  const how = `the deployer's transaction at nonce ${nonce} creates the GoldStablecoinDeployer at ${deployerContract}, and the salt with the token's creation code (hash ${initCodeHash}) gives ${token}`;
  if (plan.expected === undefined) return [pass("gsusd:address", `no address asked for; ${how}`)];
  if (token.toLowerCase() === plan.expected.toLowerCase()) return [pass("gsusd:address", `GSUSD will stand at ${token}: ${how}`)];
  return [fail("gsusd:address", `GSUSD_ADDRESS is ${plan.expected}, but ${how}. Find the salt again for this deployer contract and this hash, and set both`)];
}
