// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";

import {GoldVault} from "../../src/core/GoldVault.sol";
import {GoldOracle} from "../../src/core/GoldOracle.sol";
import {GoldStablecoin} from "../../src/core/GoldStablecoin.sol";
import {StabilityModule} from "../../src/core/StabilityModule.sol";
import {SurplusBuffer} from "../../src/core/SurplusBuffer.sol";
import {SiloFactory} from "../../src/core/CollateralSilo.sol";

import {MockAggregatorV3} from "../../src/test/mocks/MockAggregatorV3.sol";
import {MockERC20FeeOnTransfer} from "../../src/test/mocks/MockERC20FeeOnTransfer.sol";

/// @notice PoC: liquidation reverts when SiloFactory + SurplusBuffer + a
///         fee-on-transfer collateral (PAXG) are all configured together - the
///         realistic production topology. The vault pulls `collateralToSeize`
///         from the silo (losing the transfer fee), then tries to pay out the
///         full gross amount to the buffer + liquidator, leaving it short by
///         the fee and reverting on the final transfer.
contract LiquidationFeeDoSTest is Test {
    GoldVault internal vault;
    GoldOracle internal oracle;
    GoldStablecoin internal stablecoin;
    StabilityModule internal stabilityModule;
    SurplusBuffer internal buffer;
    SiloFactory internal silo;

    MockERC20FeeOnTransfer internal paxg;
    MockAggregatorV3 internal paxgFeed;
    MockAggregatorV3 internal xautFeed;

    bytes32 internal paxgId;
    int256 internal constant GOLD_PRICE = 2000 * 1e8;

    address internal borrower = address(0xB0B);
    address internal liquidator = address(0x11D);

    function setUp() public {
        // 20 bps fee-on-transfer token (even higher than real PAXG ~2bps).
        paxg = new MockERC20FeeOnTransfer("Pax Gold", "PAXG", 20);

        paxgFeed = new MockAggregatorV3(8);
        xautFeed = new MockAggregatorV3(8);
        _pushPrice(paxgFeed, GOLD_PRICE);
        _pushPrice(xautFeed, GOLD_PRICE);

        // The feed registry rejects duplicate token addresses, so the unused second
        // slot gets a distinct dummy. Safe: the decimals check runs against the feed.
        oracle = new GoldOracle(
            address(paxgFeed), address(xautFeed),
            address(paxg), address(0xDEAD),
            3600
        );
        oracle.getTokenPrice(address(paxg));

        stablecoin = new GoldStablecoin();
        stabilityModule = new StabilityModule();
        vault = new GoldVault(address(oracle), address(stablecoin), address(stabilityModule));
        buffer = new SurplusBuffer(address(stablecoin));
        silo = new SiloFactory(1000e18);

        stablecoin.grantRole(stablecoin.MINTER_ROLE(), address(vault));
        stabilityModule.grantRole(stabilityModule.VAULT_ROLE(), address(vault));
        buffer.grantRole(buffer.VAULT_ROLE(), address(vault));
        silo.grantRole(silo.VAULT_ROLE(), address(vault));

        // 150% min, 110% liq, 5% penalty
        vault.addCollateralType(address(paxg), 1_500_000, 1_100_000, 50_000, 1_000_000_000e18);
        paxgId = keccak256(abi.encodePacked(address(paxg)));
        stabilityModule.initCollateral(paxgId, 0);

        // Realistic production topology: buffer + silo both wired.
        vault.setSurplusBuffer(address(buffer));
        vault.setSiloFactory(address(silo));

        paxg.mint(borrower, 100e18);
    }

    /// @notice Regression: with SiloFactory + SurplusBuffer + a fee-on-transfer collateral
    ///         all wired (the production topology), liquidation now SUCCEEDS. Distribution is
    ///         derived from the amount actually received from the silo->vault pull, so the final
    ///         payout can never exceed the vault's balance. Before the fix this reverted with
    ///         ERC20InsufficientBalance, bricking liquidations of every PAXG vault.
    function test_liquidation_succeeds_with_silo_buffer_and_fee_token() public {
        // Borrower deposits 10 PAXG (post-fee ~9.98) and mints near the 150% floor.
        vm.startPrank(borrower);
        paxg.approve(address(vault), type(uint256).max);
        vault.deposit(address(paxg), 10e18);
        // collateral value ~ 9.98 * 2000 = ~19960; 150% -> max debt ~13306
        vault.mint(13000e18);
        vm.stopPrank();

        // Borrower funds the liquidator with the GSUSD needed to repay.
        vm.prank(borrower);
        stablecoin.transfer(liquidator, 13000e18);

        // Step the price down in <10% increments so the oracle deviation
        // circuit breaker tolerates each move and updates lastKnown.
        _stepPriceDownTo(1850);
        _stepPriceDownTo(1700);
        _stepPriceDownTo(1560);
        _stepPriceDownTo(1430); // ratio ~ 9.98*1430 / 13000 = 109.8% < 110%

        uint256 ratio = vault.getCollateralisationRatio(borrower);
        emit log_named_uint("ratio (1e6 = 100%)", ratio);
        assertLt(ratio, 1_100_000, "precondition: vault must be liquidatable");

        // Sanity: vault holds NO PAXG directly - it's all in the silo.
        assertEq(paxg.balanceOf(address(vault)), 0, "vault should hold no PAXG (all in silo)");

        uint256 liqBalBefore = paxg.balanceOf(liquidator);
        ( , , uint256 debtBefore) = vault.vaults(borrower);

        // Liquidation now SUCCEEDS: distribution is sized to the actually-received amount.
        vm.startPrank(liquidator);
        stablecoin.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0);
        vm.stopPrank();

        ( , , uint256 debtAfter) = vault.vaults(borrower);
        assertLt(debtAfter, debtBefore, "debt must fall after liquidation");
        assertGt(paxg.balanceOf(liquidator), liqBalBefore, "liquidator must receive seized collateral");
        // The vault must not be left holding a residual it cannot account for.
        assertLe(paxg.balanceOf(address(vault)), 1e12, "vault should retain at most dust");
    }

    /// @notice Control: with NO silo (collateral held directly in the vault),
    ///         the same liquidation succeeds - proving the bug is the extra
    ///         silo->vault fee hop, not the fee token in isolation.
    function test_liquidation_succeeds_without_silo() public {
        vault.setSiloFactory(address(0)); // disable silo

        vm.startPrank(borrower);
        paxg.approve(address(vault), type(uint256).max);
        vault.deposit(address(paxg), 10e18);
        vault.mint(13000e18);
        vm.stopPrank();

        vm.prank(borrower);
        stablecoin.transfer(liquidator, 13000e18);

        _stepPriceDownTo(1850);
        _stepPriceDownTo(1700);
        _stepPriceDownTo(1560);
        _stepPriceDownTo(1430);

        assertLt(vault.getCollateralisationRatio(borrower), 1_100_000, "must be liquidatable");

        vm.startPrank(liquidator);
        stablecoin.approve(address(vault), type(uint256).max);
        vault.liquidate(borrower, 0); // succeeds
        vm.stopPrank();
    }

    function _stepPriceDownTo(uint256 dollarsPerOz) internal {
        _pushPrice(paxgFeed, int256(dollarsPerOz * 1e8));
        oracle.getTokenPrice(address(paxg)); // refresh lastKnown within tolerance
    }

    function _pushPrice(MockAggregatorV3 feed, int256 price) internal {
        feed.setLatestRoundData(uint80(1), price, block.timestamp, block.timestamp, uint80(1));
    }
}
