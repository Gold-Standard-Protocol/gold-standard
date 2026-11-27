// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "forge-std/Test.sol";

import {PythMarketFeed} from "../research/oracle/PythMarketFeed.sol";
import {MockPyth} from "../research/mocks/MockPyth.sol";
import {MockPythRelayer} from "../research/mocks/MockPythRelayer.sol";

/// @notice PythMarketFeed against MockPyth: the conversion across exponents, the age and confidence
///         gates, the fee forwarding and the refund that must never block an update.
contract PythMarketFeedTest is Test {
    bytes32 internal constant ID = keccak256("XAUT/USD");
    uint256 internal constant MAX_AGE = 60;
    uint256 internal constant MAX_CONF_PPM = 5_000;

    MockPyth internal pyth;
    PythMarketFeed internal feed;
    MockPythRelayer internal relayer;

    function setUp() public {
        vm.warp(1_800_000_000);
        pyth = new MockPyth();
        feed = new PythMarketFeed(address(pyth), ID, MAX_AGE, MAX_CONF_PPM, "XAUT / USD (Pyth)");
        relayer = new MockPythRelayer();
        vm.deal(address(this), 100 ether);
    }

    function _store(int64 price, uint64 conf, int32 expo, uint256 publishTime) internal {
        pyth.setPrice(ID, price, conf, expo, publishTime);
    }

    /// @dev Across the accepted exponent range the answer is the exact 8 decimal rescaling, floored.
    function testFuzz_rescalesAnyExponent(int64 price, int32 expo) public view {
        price = int64(bound(price, 1, type(int64).max));
        expo = int32(bound(expo, -18, 0));
        (uint256 answer, PythMarketFeed.Status status) = feed.convert(price, 0, expo);
        uint256 scale = 10 ** uint256(uint32(-expo));
        uint256 expected = (uint256(uint64(price)) * 1e8) / scale;
        if (expected == 0 || expected > 1e20) {
            assertEq(answer, 0);
            assertEq(uint8(status), uint8(PythMarketFeed.Status.PRICE_OUT_OF_RANGE));
        } else {
            assertEq(answer, expected);
            assertEq(uint8(status), uint8(PythMarketFeed.Status.OK));
        }
    }

    function testFuzz_rejectsExponentsOutsideTheRange(int64 price, int32 expo) public view {
        price = int64(bound(price, 1, type(int64).max));
        vm.assume(expo < -18 || expo > 0);
        (uint256 answer, PythMarketFeed.Status status) = feed.convert(price, 0, expo);
        assertEq(answer, 0);
        assertEq(uint8(status), uint8(PythMarketFeed.Status.EXPONENT_OUT_OF_RANGE));
    }

    function testFuzz_nonPositivePriceIsInvalid(int64 price, uint64 conf, int32 expo) public view {
        price = int64(bound(price, type(int64).min, 0));
        (uint256 answer, PythMarketFeed.Status status) = feed.convert(price, conf, expo);
        assertEq(answer, 0);
        assertEq(uint8(status), uint8(PythMarketFeed.Status.INVALID_PRICE));
    }

    /// @dev The confidence gate is the true inequality conf / price > cap / 1e6, compared
    ///      by cross-multiplication with no rounding: a ratio any fraction above the cap is
    ///      refused, and one at the cap or below is accepted.
    function testFuzz_confidenceGateIsExact(int64 price, uint64 conf) public view {
        price = int64(bound(price, 1_000, type(int64).max / 1_000_000));
        conf = uint64(bound(conf, 0, uint64(price)));
        (uint256 answer, PythMarketFeed.Status status) = feed.convert(price, conf, -8);
        bool tooWide = uint256(conf) * 1_000_000 > MAX_CONF_PPM * uint256(uint64(price));
        if (tooWide) {
            assertEq(answer, 0);
            assertEq(uint8(status), uint8(PythMarketFeed.Status.WIDE_CONFIDENCE));
        } else {
            assertGt(answer, 0);
            assertEq(uint8(status), uint8(PythMarketFeed.Status.OK));
        }
    }

    /// @dev At exactly the cap, and one unit of confidence either side of it, for prices
    ///      where the cap is and is not a whole number of confidence units.
    function test_confidenceAtTheCapAndOneUnitEitherSide() public view {
        // $4,000.00000000: 5,000 ppm is exactly 20_00000000 units.
        _expectConfidence(4000_00000000, 20_00000000 - 1, true);
        _expectConfidence(4000_00000000, 20_00000000, true);
        _expectConfidence(4000_00000000, 20_00000000 + 1, false);
        // 1,001 units: 5,000 ppm is 5.005 units, so 5 is inside and 6 is outside.
        _expectConfidence(1_001, 5, true);
        _expectConfidence(1_001, 6, false);
        // 1,000 units: the cap is exactly 5.
        _expectConfidence(1_000, 4, true);
        _expectConfidence(1_000, 5, true);
        _expectConfidence(1_000, 6, false);
        // 400,001 units: 2,000 units is 4,999.99 ppm and 2,001 is 5,002.49 ppm. A ratio a
        // fraction above the cap is refused although it floors to the cap in whole ppm:
        // 200_001 against 40_000_100 is 5,000.0125 ppm.
        _expectConfidence(400_001, 2_000, true);
        _expectConfidence(400_001, 2_001, false);
        _expectConfidence(40_000_100, 200_000, true);
        _expectConfidence(40_000_100, 200_001, false);
    }

    /// @dev The largest inputs the types allow do not overflow the comparison.
    function test_confidenceGateDoesNotOverflowAtTheTypeLimits() public view {
        (, PythMarketFeed.Status wide) = feed.convert(type(int64).max, type(uint64).max, -18);
        assertEq(uint8(wide), uint8(PythMarketFeed.Status.WIDE_CONFIDENCE));
        (uint256 answer, PythMarketFeed.Status narrow) = feed.convert(type(int64).max, 0, -18);
        assertEq(uint8(narrow), uint8(PythMarketFeed.Status.OK));
        assertGt(answer, 0);
    }

    function _expectConfidence(int64 price, uint64 conf, bool accepted) internal view {
        (, PythMarketFeed.Status status) = feed.convert(price, conf, 0);
        // An exponent of 0 can put the price out of range; only the confidence verdict matters.
        bool wide = status == PythMarketFeed.Status.WIDE_CONFIDENCE;
        assertEq(wide, !accepted, "confidence verdict");
    }

    /// @dev A stored price older than maxAge, or from the future, answers 0 with every field 0.
    function testFuzz_ageGate(uint256 age) public {
        age = bound(age, 0, 7 days);
        _store(4000_00000000, 2_00000000, -8, block.timestamp - age);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        (, PythMarketFeed.Status status) = feed.readPrice();
        if (age > MAX_AGE) {
            assertEq(answer, 0);
            assertEq(roundId, 0);
            assertEq(updatedAt, 0);
            assertEq(uint8(status), uint8(PythMarketFeed.Status.STALE));
        } else {
            assertEq(answer, 4000_00000000);
            assertEq(startedAt, block.timestamp - age);
            assertEq(updatedAt, block.timestamp - age);
            assertEq(roundId, uint80(block.timestamp - age));
            assertEq(answeredInRound, roundId);
            assertEq(uint8(status), uint8(PythMarketFeed.Status.OK));
        }
    }

    function testFuzz_futurePublishTimeIsInvalid(uint256 ahead) public {
        ahead = bound(ahead, 1, 365 days);
        _store(4000_00000000, 0, -8, block.timestamp + ahead);
        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, 0);
        (, PythMarketFeed.Status status) = feed.readPrice();
        assertEq(uint8(status), uint8(PythMarketFeed.Status.FUTURE_PUBLISH_TIME));
    }

    /// @dev Whatever the stored price, the read never reverts and a non zero answer only comes with OK.
    function testFuzz_neverRevertsAndZeroUnlessOk(int64 price, uint64 conf, int32 expo, uint256 publishTime) public {
        _store(price, conf, expo, publishTime);
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        (uint256 read, PythMarketFeed.Status status) = feed.readPrice();
        assertEq(uint256(answer), read);
        if (read != 0) {
            assertEq(uint8(status), uint8(PythMarketFeed.Status.OK));
            assertEq(updatedAt, publishTime);
        } else {
            assertEq(updatedAt, 0);
        }
    }

    /// @dev Exactly the fee goes to Pyth and the rest comes back, for any fee and any overpayment.
    function testFuzz_forwardsTheFeeAndRefundsTheRest(uint96 feePerUpdate, uint96 extra, uint8 count) public {
        count = uint8(bound(count, 1, 4));
        pyth.setFeePerUpdate(feePerUpdate);
        bytes[] memory updates = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            updates[i] = pyth.encodeUpdate(ID, 4000_00000000, 1_00000000, -8, block.timestamp - i);
        }
        uint256 fee = uint256(feePerUpdate) * count;
        assertEq(feed.getUpdateFee(updates), fee);
        vm.deal(address(this), fee + extra);
        uint256 before = address(this).balance;
        feed.updatePrice{value: fee + extra}(updates);
        assertEq(address(this).balance, before - fee, "only the fee left the caller");
        assertEq(pyth.feesReceived(), fee);
        assertEq(address(feed).balance, 0, "the feed keeps nothing");
        assertEq(pyth.updatesApplied(), 1, "only the newest update is stored");
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(answer, 4000_00000000);
        assertEq(updatedAt, block.timestamp);
    }

    function testFuzz_underpaymentReverts(uint96 feePerUpdate, uint96 paid) public {
        feePerUpdate = uint96(bound(feePerUpdate, 1, type(uint96).max));
        paid = uint96(bound(paid, 0, feePerUpdate - 1));
        pyth.setFeePerUpdate(feePerUpdate);
        bytes[] memory updates = new bytes[](1);
        updates[0] = pyth.encodeUpdate(ID, 4000_00000000, 0, -8, block.timestamp);
        vm.deal(address(this), paid);
        vm.expectRevert(abi.encodeWithSelector(PythMarketFeed.InsufficientFee.selector, uint256(feePerUpdate), uint256(paid)));
        feed.updatePrice{value: paid}(updates);
    }

    /// @dev A relayer that rejects ETH still gets its update stored; the excess waits for claimRefund.
    function testFuzz_rejectedRefundDoesNotBlockTheUpdate(uint96 extra) public {
        extra = uint96(bound(extra, 1, 10 ether));
        pyth.setFeePerUpdate(0.001 ether);
        relayer.setAcceptEth(false);
        bytes[] memory updates = new bytes[](1);
        updates[0] = pyth.encodeUpdate(ID, 4001_00000000, 0, -8, block.timestamp);
        vm.expectEmit(true, false, false, true, address(feed));
        emit PythMarketFeed.RefundFailed(address(relayer), extra);
        // The summary reports nothing refunded: the excess is owed, not paid.
        vm.expectEmit(true, false, false, true, address(feed));
        emit PythMarketFeed.PriceUpdated(address(relayer), 0.001 ether, 0);
        relayer.relay{value: 0.001 ether + extra}(feed, updates);
        assertEq(pyth.updatesApplied(), 1);
        assertEq(feed.pendingRefunds(address(relayer)), extra);
        assertEq(address(feed).balance, extra);
        // Still refusing: the claim reverts and the credit stays.
        vm.expectRevert(abi.encodeWithSelector(PythMarketFeed.RefundTransferFailed.selector, address(relayer), uint256(extra)));
        relayer.claim(feed);
        assertEq(feed.pendingRefunds(address(relayer)), extra);
        // Accepting again: the claim pays out once and only once.
        relayer.setAcceptEth(true);
        relayer.claim(feed);
        assertEq(relayer.received(), extra);
        assertEq(feed.pendingRefunds(address(relayer)), 0);
        assertEq(address(feed).balance, 0);
        vm.expectRevert(PythMarketFeed.NothingToClaim.selector);
        relayer.claim(feed);
    }

    function test_constructorBounds() public {
        vm.expectRevert(PythMarketFeed.ZeroAddress.selector);
        new PythMarketFeed(address(0), ID, MAX_AGE, MAX_CONF_PPM, "");
        vm.expectRevert(abi.encodeWithSelector(PythMarketFeed.NotAContract.selector, address(0xBEEF)));
        new PythMarketFeed(address(0xBEEF), ID, MAX_AGE, MAX_CONF_PPM, "");
        vm.expectRevert(PythMarketFeed.ZeroPriceId.selector);
        new PythMarketFeed(address(pyth), bytes32(0), MAX_AGE, MAX_CONF_PPM, "");
        vm.expectRevert(abi.encodeWithSelector(PythMarketFeed.MaxAgeOutOfRange.selector, 9));
        new PythMarketFeed(address(pyth), ID, 9, MAX_CONF_PPM, "");
        vm.expectRevert(abi.encodeWithSelector(PythMarketFeed.MaxAgeOutOfRange.selector, 3601));
        new PythMarketFeed(address(pyth), ID, 3601, MAX_CONF_PPM, "");
        vm.expectRevert(abi.encodeWithSelector(PythMarketFeed.MaxConfidenceOutOfRange.selector, 0));
        new PythMarketFeed(address(pyth), ID, MAX_AGE, 0, "");
        vm.expectRevert(abi.encodeWithSelector(PythMarketFeed.MaxConfidenceOutOfRange.selector, 50_001));
        new PythMarketFeed(address(pyth), ID, MAX_AGE, 50_001, "");
        new PythMarketFeed(address(pyth), ID, 10, 50_000, "edge");
        new PythMarketFeed(address(pyth), ID, 3600, 1, "edge");
    }

    function test_unreadableFeedIsInvalid() public {
        pyth.setRevertOnRead(true);
        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, 0);
        (, PythMarketFeed.Status status) = feed.readPrice();
        assertEq(uint8(status), uint8(PythMarketFeed.Status.FEED_FAILED));
    }

    receive() external payable {}
}
