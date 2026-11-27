import { expect } from "chai";
import { getCreate2Address, getCreateAddress, ZeroHash } from "ethers";
import { parseStablecoinAddressEnv, predictStablecoinAddress, stablecoinAddressFindings } from "../scripts/lib/stablecoinAddress";

const DEPLOYER = "0x78a4586Ba99045eaEBae03ba5624d7f55dDEa584";
const HASH = "0x317f52e85e3e09dd24f391002fa8ba72cf171de2af49efd426bcbc66c8d1e17f";
const SALT = "0x3a91af6532497630496ce82d8e7c6d8569aba0072bdd826e67dfe92acdcebb0b";
const ADDRESS = "0x24C3597eF975bdB565fd146f61438Ef14e15601D";

describe("the token's address plan (scripts/lib/stablecoinAddress.ts)", () => {
  describe("GSUSD_SALT and GSUSD_ADDRESS", () => {
    it("takes both, the address in its checksummed form", () => {
      const { plan, findings } = parseStablecoinAddressEnv({ GSUSD_SALT: ` ${SALT.toUpperCase().replace("0X", "0x")} `, GSUSD_ADDRESS: ADDRESS.toLowerCase() }, true);
      expect(findings).to.deep.equal([]);
      expect(plan).to.deep.equal({ salt: SALT, expected: ADDRESS });
    });

    it("takes neither off mainnet: the zero salt and no expectation", () => {
      expect(parseStablecoinAddressEnv({}, false)).to.deep.equal({ plan: { salt: ZeroHash, expected: undefined }, findings: [] });
      expect(parseStablecoinAddressEnv({ GSUSD_SALT: " ", GSUSD_ADDRESS: "" }, false).plan?.salt).to.equal(ZeroHash);
    });

    it("refuses neither on mainnet", () => {
      const { plan, findings } = parseStablecoinAddressEnv({}, true);
      expect(plan).to.equal(undefined);
      expect(findings.map((f) => `${f.verdict} ${f.name}`)).to.deep.equal(["fail env:GSUSD_ADDRESS"]);
    });

    it("refuses one without the other, on every network", () => {
      for (const mandatory of [true, false]) {
        expect(parseStablecoinAddressEnv({ GSUSD_SALT: SALT }, mandatory).findings.map((f) => f.name)).to.deep.equal(["env:GSUSD_ADDRESS"]);
        expect(parseStablecoinAddressEnv({ GSUSD_ADDRESS: ADDRESS }, mandatory).findings.map((f) => f.name)).to.deep.equal(["env:GSUSD_SALT"]);
        expect(parseStablecoinAddressEnv({ GSUSD_SALT: SALT }, mandatory).plan).to.equal(undefined);
      }
    });

    it("refuses a salt that is not 32 bytes and an address whose capitals do not match its checksum", () => {
      for (const salt of ["0x1234", SALT.slice(0, -2), `${SALT}00`, SALT.slice(2), "0x" + "zz".repeat(32)]) {
        expect(parseStablecoinAddressEnv({ GSUSD_SALT: salt, GSUSD_ADDRESS: ADDRESS }, true).findings.map((f) => f.name), salt).to.deep.equal(["env:GSUSD_SALT"]);
      }
      const wrongCase = ADDRESS.replace("24C", "24c");
      for (const address of ["0x24C", wrongCase, "not an address"]) {
        expect(parseStablecoinAddressEnv({ GSUSD_SALT: SALT, GSUSD_ADDRESS: address }, true).findings.map((f) => f.name), address).to.deep.equal(["env:GSUSD_ADDRESS"]);
      }
    });
  });

  describe("the address a plan gives", () => {
    it("follows from the deployer's address and nonce, the salt and the creation code hash", () => {
      const predicted = predictStablecoinAddress(DEPLOYER, 0, SALT, HASH);
      expect(predicted.deployerContract).to.equal(getCreateAddress({ from: DEPLOYER, nonce: 0 }));
      expect(predicted.token).to.equal(getCreate2Address(predicted.deployerContract, SALT, HASH));
    });

    it("gives the mainnet address for the mainnet deployer at nonce 0, with the capitals asked for", () => {
      const predicted = predictStablecoinAddress(DEPLOYER, 0, SALT, HASH);
      expect(predicted.deployerContract).to.equal("0x89D3da6da9BD48411060205709185f990A5D7Ec0");
      expect(predicted.token).to.equal(ADDRESS);
      expect(ADDRESS.startsWith("0x24C")).to.equal(true);
      expect(ADDRESS.endsWith("601D")).to.equal(true);
    });

    it("passes a plan whose salt gives its address and names every input", () => {
      const [finding] = stablecoinAddressFindings({ salt: SALT, expected: ADDRESS }, DEPLOYER, 0, HASH);
      expect(finding.verdict).to.equal("pass");
      expect(finding.name).to.equal("gsusd:address");
      expect(finding.detail).to.include(ADDRESS).and.include("nonce 0").and.include("0x89D3da6da9BD48411060205709185f990A5D7Ec0").and.include(HASH);
    });

    it("fails the same plan at another nonce, from another deployer or with other creation code", () => {
      const plan = { salt: SALT, expected: ADDRESS };
      expect(stablecoinAddressFindings(plan, DEPLOYER, 1, HASH)[0].verdict).to.equal("fail");
      expect(stablecoinAddressFindings(plan, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", 0, HASH)[0].verdict).to.equal("fail");
      const other = stablecoinAddressFindings(plan, DEPLOYER, 0, ZeroHash)[0];
      expect(other.verdict).to.equal("fail");
      expect(other.detail).to.include("Find the salt again");
    });

    it("passes a plan with no expectation and says where the token will stand", () => {
      const [finding] = stablecoinAddressFindings({ salt: ZeroHash, expected: undefined }, DEPLOYER, 0, HASH);
      expect(finding.verdict).to.equal("pass");
      expect(finding.detail).to.include(predictStablecoinAddress(DEPLOYER, 0, ZeroHash, HASH).token);
    });
  });
});

describe("the token's creation code", () => {
  it("still hashes to the value the mainnet salt was found for", async () => {
    const { artifacts, ethers } = await import("hardhat");
    expect(ethers.keccak256((await artifacts.readArtifact("GoldStablecoin")).bytecode)).to.equal(HASH);
  });
});
