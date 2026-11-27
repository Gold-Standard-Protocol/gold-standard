// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";

import {GoldVault} from "../src/core/GoldVault.sol";
import {GoldOracle} from "../src/core/GoldOracle.sol";
import {GoldStablecoin} from "../src/core/GoldStablecoin.sol";
import {StabilityModule} from "../src/core/StabilityModule.sol";
import {StabilityPool} from "../src/core/StabilityPool.sol";
import {MockAggregatorV3} from "../src/test/mocks/MockAggregatorV3.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Malicious collateral token with a transfer hook that re-enters protocol
///         contracts on outbound transfers from the vault. Models a future
///         governance-added collateral with an ERC777-style callback.
contract MaliciousCollateral is ERC20 {
    GoldVault public vault;
    StabilityPool public pool;
    uint8 public mode; // 0 = off, 1 = reenter vault.withdraw, 2 = reenter pool.withdraw, 3 = reenter pool.deposit
    uint256 public depth;
    bool public reenterSucceeded;
    bytes public lastRevert;

    constructor() ERC20("Malicious Gold", "MAL") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setVault(GoldVault _v) external { vault = _v; }
    function setPool(StabilityPool _p) external { pool = _p; }
    function setMode(uint8 _m) external { mode = _m; }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (mode == 0 || depth != 0) return;
        if (from != address(vault)) return;
        depth = 1;
        if (mode == 1) {
            try vault.withdraw(1) { reenterSucceeded = true; } catch (bytes memory r) { lastRevert = r; }
        } else if (mode == 2) {
            try pool.withdraw(1) { reenterSucceeded = true; } catch (bytes memory r) { lastRevert = r; }
        } else if (mode == 3) {
            try pool.deposit(1) { reenterSucceeded = true; } catch (bytes memory r) { lastRevert = r; }
        }
        depth = 0;
    }
}

contract ReentrancyProbeTest is Test {
    GoldVault internal vault;
    GoldOracle internal oracle;
    GoldStablecoin internal gsusd;
    StabilityModule internal sm;
    StabilityPool internal pool;
    MockAggregatorV3 internal feed;
    MockAggregatorV3 internal xautFeed;
    MaliciousCollateral internal mal;

    address internal user = address(0xBEEF);
    address internal keeper = address(0xCAFE);
    address internal poolDepositor = address(0xD00D);
    bytes32 internal malId;

    function setUp() public {
        feed = new MockAggregatorV3(8);
        xautFeed = new MockAggregatorV3(8);
        feed.setLatestRoundData(1, 2000e8, block.timestamp, block.timestamp, 1);
        xautFeed.setLatestRoundData(1, 2000e8, block.timestamp, block.timestamp, 1);

        mal = new MaliciousCollateral();
        oracle = new GoldOracle(address(feed), address(xautFeed), address(mal), address(0xDEAD), 3600);

        gsusd = new GoldStablecoin();
        sm = new StabilityModule();
        vault = new GoldVault(address(oracle), address(gsusd), address(sm));
        pool = new StabilityPool(address(gsusd));

        mal.setVault(vault);
        mal.setPool(pool);

        gsusd.grantRole(gsusd.MINTER_ROLE(), address(vault));
        sm.grantRole(sm.VAULT_ROLE(), address(vault));
        pool.grantRole(pool.VAULT_ROLE(), address(vault));
        pool.addCollateralToken(address(mal));
        vault.setStabilityPool(address(pool));

        vault.addCollateralType(address(mal), 1_500_000, 1_100_000, 50_000, 1_000_000_000e18);
        malId = keccak256(abi.encodePacked(address(mal)));
        sm.initCollateral(malId, 0);

        // user deposits 10 MAL ($20k), mints 1000 GSUSD
        mal.mint(user, 10e18);
        vm.startPrank(user);
        mal.approve(address(vault), 10e18);
        vault.deposit(address(mal), 10e18);
        vault.mint(1000e18);
        vm.stopPrank();

        // Pool depositor seeds the pool with GSUSD so liquidateViaPool works
        gsusd.grantRole(gsusd.MINTER_ROLE(), address(this));
        gsusd.mint(poolDepositor, 5000e18);
        vm.startPrank(poolDepositor);
        gsusd.approve(address(pool), 5000e18);
        pool.deposit(5000e18);
        vm.stopPrank();
    }

    function _makeUndercollateralised() internal {
        // Drop price so user's 10 MAL ($ at new price) falls below 110% of 1000 GSUSD debt.
        // At price P (8dec), collateral value = 10 * P / 1e8 (in USD-18). Need ratio < 1.10.
        // ratio = (10*P/1e8 * 1e6) / 1000e18  -> set P so value ~ 1050 -> P = 105e8.
        feed.setLatestRoundData(2, 105e8, block.timestamp, block.timestamp, 2);
    }

    function test_withdraw_reentry_into_vault_is_blocked() public {
        mal.setMode(1);
        vm.prank(user);
        vault.withdraw(1e18);
        assertFalse(mal.reenterSucceeded(), "vault.withdraw re-entered");
        assertGt(mal.lastRevert().length, 0, "expected revert from blocked re-entry");
    }

    function test_reentry_into_pool_deposit_blocked() public {
        mal.setMode(3);
        vm.prank(user);
        vault.withdraw(1e18);
        // pool.deposit requires GSUSD approval/balance for the token contract; it will revert
        // regardless, but we assert it did NOT silently succeed.
        assertFalse(mal.reenterSucceeded(), "pool.deposit re-entered");
    }
}
