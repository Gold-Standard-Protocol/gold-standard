// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";
import {GoldVault} from "../../src/core/GoldVault.sol";
import {GoldOracle} from "../../src/core/GoldOracle.sol";
import {GoldStablecoin} from "../../src/core/GoldStablecoin.sol";
import {StabilityModule} from "../../src/core/StabilityModule.sol";
import {StabilityPool} from "../../src/core/StabilityPool.sol";
import {SurplusBuffer} from "../../src/core/SurplusBuffer.sol";
import {GoldStabilityReserve} from "../../src/core/GoldStabilityReserve.sol";
import {MockAggregatorV3} from "../../src/test/mocks/MockAggregatorV3.sol";
import {MockERC20} from "../../src/test/mocks/MockERC20.sol";

/// @notice Full-stack harness for regression tests: PAXG (18) and XAUT (6) at 4000e8 with the
/// vault, module, pool, buffer and reserve wired the way deploy.ts wires them.
abstract contract FullStackHarness is Test {
    GoldVault internal vault;
    GoldOracle internal oracle;
    GoldStablecoin internal gsusd;
    StabilityModule internal module;
    StabilityPool internal pool;
    SurplusBuffer internal buffer;
    GoldStabilityReserve internal reserve;

    MockERC20 internal paxg;
    MockERC20 internal xaut;
    MockAggregatorV3 internal paxgFeed;
    MockAggregatorV3 internal xautFeed;

    bytes32 internal paxgId;
    bytes32 internal xautId;

    int256 internal constant PRICE = 4000e8;
    uint256 internal constant ONE_XAUT = 1_000_000;

    function _feeBps() internal pure virtual returns (uint256) { return 0; }

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        paxg = new MockERC20("Pax Gold", "PAXG", 18);
        xaut = new MockERC20("Tether Gold", "XAUT", 6);
        paxgFeed = new MockAggregatorV3(8);
        xautFeed = new MockAggregatorV3(8);
        _push(paxgFeed, PRICE);
        _push(xautFeed, PRICE);

        oracle = new GoldOracle(address(paxgFeed), address(xautFeed), address(paxg), address(xaut), 90000);
        oracle.getTokenPrice(address(paxg));
        oracle.getTokenPrice(address(xaut));

        gsusd = new GoldStablecoin();
        module = new StabilityModule();
        vault = new GoldVault(address(oracle), address(gsusd), address(module));
        buffer = new SurplusBuffer(address(gsusd));
        pool = new StabilityPool(address(gsusd));
        reserve = new GoldStabilityReserve(address(gsusd), address(oracle));

        gsusd.grantRole(gsusd.MINTER_ROLE(), address(vault));
        module.grantRole(module.VAULT_ROLE(), address(vault));
        buffer.grantRole(buffer.VAULT_ROLE(), address(vault));
        buffer.grantRole(buffer.VAULT_ROLE(), address(reserve));
        pool.grantRole(pool.VAULT_ROLE(), address(vault));
        reserve.grantRole(reserve.VAULT_ROLE(), address(vault));

        vault.setSurplusBuffer(address(buffer));
        vault.setStabilityPool(address(pool));
        vault.setStabilityReserve(address(reserve));
        vault.setReservePenaltyShare(4000);

        pool.addCollateralToken(address(paxg));
        pool.addCollateralToken(address(xaut));

        reserve.setSurplusBuffer(address(buffer));
        reserve.setAssetConfig(address(paxg), true, 0, 1_000_000);
        reserve.setAssetConfig(address(xaut), true, 0, 1_000_000);
        GoldStabilityReserve.SpreadStep[] memory steps = new GoldStabilityReserve.SpreadStep[](2);
        steps[0] = GoldStabilityReserve.SpreadStep({coverageAtLeastPpm: 100_000, spreadPpm: 5_000});
        steps[1] = GoldStabilityReserve.SpreadStep({coverageAtLeastPpm: 20_000, spreadPpm: 12_500});
        reserve.setSpreadCurve(steps, 20_000);

        // 150% min, 110% liquidation, 5% penalty
        vault.addCollateralType(address(paxg), 1_500_000, 1_100_000, 50_000, 1_000_000_000e18);
        vault.addCollateralType(address(xaut), 1_500_000, 1_100_000, 50_000, 1_000_000_000e18);
        paxgId = keccak256(abi.encodePacked(address(paxg)));
        xautId = keccak256(abi.encodePacked(address(xaut)));
        module.initCollateral(paxgId, _feeBps());
        module.initCollateral(xautId, _feeBps());
    }

    function _push(MockAggregatorV3 feed, int256 price) internal {
        feed.setLatestRoundData(1, price, block.timestamp, block.timestamp, 1);
    }

    function _setPrice(int256 price) internal {
        _push(paxgFeed, price);
        _push(xautFeed, price);
    }

    /// @dev Walk the feeds to `target` in <10% steps, re-anchoring lastKnown each step so the
    ///      deviation gate never trips (a normal multi-update market move).
    function _walkPrice(int256 target) internal {
        int256 cur = int256(oracle.getLastKnownPrice(address(xaut)));
        while (cur != target) {
            int256 next;
            if (target < cur) {
                next = cur * 91 / 100;
                if (next < target) next = target;
            } else {
                next = cur * 109 / 100;
                if (next > target) next = target;
            }
            _setPrice(next);
            oracle.getTokenPrice(address(paxg));
            oracle.getTokenPrice(address(xaut));
            cur = next;
        }
    }

    function _open(address who, MockERC20 token, uint256 collateral, uint256 debt) internal {
        token.mint(who, collateral);
        vm.startPrank(who);
        token.approve(address(vault), collateral);
        vault.deposit(address(token), collateral);
        if (debt > 0) vault.mint(debt);
        vm.stopPrank();
    }

    function _fundGsusd(address who, uint256 amount) internal {
        // Mint through a throwaway PAXG vault so supply == debt stays honest.
        address funder = address(uint160(uint256(keccak256(abi.encodePacked("funder", who, amount)))));
        uint256 price = oracle.getLastKnownPrice(address(paxg)); // 8 dec
        uint256 coll = (amount * 2 * 1e8) / price + 1e18; // 200%+ at the current price
        _open(funder, paxg, coll, amount);
        vm.prank(funder);
        gsusd.transfer(who, amount);
    }

    function _vault(address who) internal view returns (address token, uint256 coll, uint256 debt) {
        (token, coll, debt) = vault.vaults(who);
    }
}
