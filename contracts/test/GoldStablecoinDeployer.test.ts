import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import { getCreate2Address, getCreateAddress, keccak256, ZeroAddress, ZeroHash } from "ethers";

const SALT = "0x" + "11".repeat(32);

describe("GoldStablecoinDeployer", () => {
  async function fixture() {
    const [owner, stranger] = await ethers.getSigners();
    const nonce = await owner.getNonce();
    const deployer = await (await ethers.getContractFactory("GoldStablecoinDeployer", owner)).deploy();
    await deployer.waitForDeployment();
    return { owner, stranger, nonce, deployer, address: await deployer.getAddress() };
  }

  it("stands at the address its creator's nonce fixes, with the creator as owner and no token yet", async () => {
    const { owner, nonce, deployer, address } = await fixture();
    expect(address).to.equal(getCreateAddress({ from: owner.address, nonce }));
    expect(await deployer.owner()).to.equal(owner.address);
    expect(await deployer.token()).to.equal(ZeroAddress);
    expect(await deployer.tokenBlock()).to.equal(0n);
  });

  it("hashes exactly the creation code of the GoldStablecoin artifact, so the address can be computed off chain", async () => {
    const { deployer, address } = await fixture();
    const artifact = await artifacts.readArtifact("GoldStablecoin");
    expect(await deployer.initCodeHash()).to.equal(keccak256(artifact.bytecode));
    expect(await deployer.predict(SALT)).to.equal(getCreate2Address(address, SALT, keccak256(artifact.bytecode)));
    expect(await deployer.predict(SALT)).to.not.equal(await deployer.predict(ZeroHash));
  });

  it("creates the token at the predicted address with the code of a direct deployment, bound to its own address", async () => {
    const { owner, deployer } = await fixture();
    const predicted = await deployer.predict(SALT);
    await expect(deployer.deploy(SALT)).to.emit(deployer, "TokenDeployed").withArgs(predicted, SALT, owner.address);
    expect(await deployer.token()).to.equal(predicted);
    expect(await deployer.tokenBlock()).to.equal(BigInt(await ethers.provider.getBlockNumber()));
    const direct = await (await ethers.getContractFactory("GoldStablecoin", owner)).deploy();
    await direct.waitForDeployment();
    // The runtime code carries the token's own address and its permit domain as immutables, so
    // two instances are the same length and differ only there; each names itself in its domain.
    const [code, directCode] = [await ethers.provider.getCode(predicted), await ethers.provider.getCode(await direct.getAddress())];
    expect(code.length).to.equal(directCode.length);
    expect(code.split(predicted.slice(2).toLowerCase()).join("")).to.not.equal(code);
    const token = await ethers.getContractAt("GoldStablecoin", predicted);
    expect((await token.eip712Domain()).verifyingContract).to.equal(predicted);
    expect(await token.name()).to.equal("Gold Standard Dollar");
    expect(await token.symbol()).to.equal("GSUSD");
    expect(await token.totalSupply()).to.equal(0n);
  });

  it("leaves the owner as the token's only admin and keeps no role itself", async () => {
    const { owner, deployer, address } = await fixture();
    await deployer.deploy(SALT);
    const token = await ethers.getContractAt("GoldStablecoin", await deployer.token());
    const admin = await token.DEFAULT_ADMIN_ROLE();
    const minter = await token.MINTER_ROLE();
    expect(await token.getRoleMemberCount(admin)).to.equal(1n);
    expect(await token.getRoleMember(admin, 0)).to.equal(owner.address);
    expect(await token.hasRole(admin, address)).to.equal(false);
    expect(await token.getRoleMemberCount(minter)).to.equal(0n);
  });

  it("leaves a token the owner administers exactly as one it created directly: grant a minter, mint, hand over", async () => {
    const { owner, stranger, deployer } = await fixture();
    await deployer.deploy(SALT);
    const token = await ethers.getContractAt("GoldStablecoin", await deployer.token());
    const minter = await token.MINTER_ROLE();
    await token.grantRole(minter, owner.address);
    await token.mint(stranger.address, 5n);
    expect(await token.balanceOf(stranger.address)).to.equal(5n);
    await expect(token.connect(stranger).grantRole(minter, stranger.address)).to.be.reverted;
  });

  it("refuses anyone but its owner, so nobody else can take the address", async () => {
    const { stranger, deployer } = await fixture();
    await expect(deployer.connect(stranger).deploy(SALT)).to.be.revertedWith("Not owner");
    expect(await deployer.token()).to.equal(ZeroAddress);
  });

  it("creates one token and no more, with the same salt or another", async () => {
    const { deployer } = await fixture();
    await deployer.deploy(SALT);
    const first = await deployer.token();
    await expect(deployer.deploy(SALT)).to.be.revertedWith("Already deployed");
    await expect(deployer.deploy(ZeroHash)).to.be.revertedWith("Already deployed");
    expect(await deployer.token()).to.equal(first);
  });

  it("gives a second deployer a different token address for the same salt", async () => {
    const a = await fixture();
    const b = await fixture();
    expect(await a.deployer.predict(SALT)).to.not.equal(await b.deployer.predict(SALT));
  });
});
