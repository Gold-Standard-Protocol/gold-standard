// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.38;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice The parts of Pyth's on chain interface this feed uses, transcribed from the published
///         pyth-crosschain sources (PythStructs.sol and IPyth.sol, Apache-2.0) rather than installed.
library PythStructs {
    /// @notice A price with a confidence interval, both as `x * 10^expo`, and its publish time.
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }
}

interface IPyth {
    /// @notice The most recent stored price for `id`, with no recency check: the caller must check publishTime.
    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory price);

    /// @notice Verifies the signed updates and stores any that are newer than the stored price. Needs the fee.
    function updatePriceFeeds(bytes[] calldata updateData) external payable;

    /// @notice The fee, in wei, that updatePriceFeeds needs for these updates.
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);
}

/// @title PythMarketFeed
/// @notice An 8 decimal AggregatorV3 style USD price for one Pyth price id, read from the Pyth
///         contract's stored price and refreshed by anyone who relays a signed Pyth update.
///         Not used in production: the GoldOracle prices on Chainlink PAXG/USD and XAU/USD alone, and
///         no deployment or preflight path deploys or wires this contract. Kept for research only.
/// @dev Contract with GoldOracle: decimals() is 8, latestRoundData() never reverts after construction
///      and an unsafe price is signalled as answer 0 (which the oracle rejects as invalid), never as a
///      low or stale price dressed as fresh. Round and stamps are the update's publishTime.
///
///      Authentication. Pyth prices are signed by its publishers and attested through Wormhole; the
///      Pyth contract verifies those signatures in updatePriceFeeds and stores only a newer price, so a
///      relayer can neither forge a price nor roll one back. What a relayer can do is choose which of
///      the recent signed updates to relay (a selective update): a price a few seconds old, or one with
///      a wider confidence interval than the latest. maxAgeSeconds bounds how old a relayed price may
///      be before this feed answers 0, and maxConfidencePpm bounds how uncertain. The protocol's own
///      keeper relays the latest update on a schedule, so a selective relayer competes with it.
///
///      Fee. updatePriceFeeds charges getUpdateFee, which is 0 on Ethereum mainnet today; updatePrice
///      forwards exactly that fee and returns any excess to the caller. A caller that refuses the
///      refund does not block the update: the excess is held for them to claim with claimRefund.
contract PythMarketFeed {
    /// @notice Why a read produced the answer it did. OK is the only status with a non zero answer.
    enum Status {
        OK,
        FEED_FAILED,
        INVALID_PRICE,
        STALE,
        FUTURE_PUBLISH_TIME,
        WIDE_CONFIDENCE,
        EXPONENT_OUT_OF_RANGE,
        PRICE_OUT_OF_RANGE
    }

    /// @notice Bounds for maxAgeSeconds: Pyth publishes every few hundred milliseconds, so a price
    ///         older than an hour is not a market price, and under 10 s a relay cannot land in time.
    uint256 public constant MIN_MAX_AGE = 10;
    uint256 public constant MAX_MAX_AGE = 1 hours;
    /// @notice Ceiling for maxConfidencePpm: a 5% interval is too wide to price collateral on.
    uint256 public constant MAX_CONFIDENCE_PPM_CAP = 50_000;
    /// @notice Accepted exponent range. Pyth USD prices carry negative exponents (XAUT/USD is -8); an
    ///         exponent below -18 or above 0 is not a price this feed can represent at 8 decimals.
    int32 public constant MIN_EXPO = -18;
    int32 public constant MAX_EXPO = 0;
    /// @notice Ceiling for the answer, one trillion dollars at 8 decimals, as in UniswapV3TwapFeed.
    uint256 public constant MAX_USD_PRICE = 1e20;

    /// @notice The Pyth contract.
    IPyth public immutable pyth;
    /// @notice The Pyth price id this feed reads.
    bytes32 public immutable priceId;
    /// @notice Longest accepted age of the stored price, in seconds.
    uint256 public immutable maxAgeSeconds;
    /// @notice Widest accepted confidence interval, in parts per million of the price.
    uint256 public immutable maxConfidencePpm;

    /// @notice Human readable label, for example "XAUT / USD (Pyth)".
    string public description;

    /// @notice Excess fee a caller could not receive, claimable with claimRefund.
    mapping(address => uint256) public pendingRefunds;

    /// @param refunded Excess actually returned to the relayer in this call; zero when the
    ///        refund could not be delivered and was credited to pendingRefunds instead.
    event PriceUpdated(address indexed relayer, uint256 fee, uint256 refunded);
    event RefundFailed(address indexed to, uint256 amount);
    event RefundClaimed(address indexed to, uint256 amount);

    error ZeroAddress();
    error NotAContract(address account);
    error ZeroPriceId();
    error MaxAgeOutOfRange(uint256 maxAgeSeconds);
    error MaxConfidenceOutOfRange(uint256 maxConfidencePpm);
    error InsufficientFee(uint256 required, uint256 provided);
    error NothingToClaim();
    error RefundTransferFailed(address to, uint256 amount);

    /// @param pyth_ The Pyth contract on this chain.
    /// @param priceId_ The Pyth price id, for example XAUT/USD.
    /// @param maxAgeSeconds_ Longest accepted price age, MIN_MAX_AGE to MAX_MAX_AGE.
    /// @param maxConfidencePpm_ Widest accepted confidence interval in ppm of the price, at most MAX_CONFIDENCE_PPM_CAP.
    /// @param description_ Label returned by description().
    constructor(address pyth_, bytes32 priceId_, uint256 maxAgeSeconds_, uint256 maxConfidencePpm_, string memory description_) {
        if (pyth_ == address(0)) revert ZeroAddress();
        if (pyth_.code.length == 0) revert NotAContract(pyth_);
        if (priceId_ == bytes32(0)) revert ZeroPriceId();
        if (maxAgeSeconds_ < MIN_MAX_AGE || maxAgeSeconds_ > MAX_MAX_AGE) revert MaxAgeOutOfRange(maxAgeSeconds_);
        if (maxConfidencePpm_ == 0 || maxConfidencePpm_ > MAX_CONFIDENCE_PPM_CAP) revert MaxConfidenceOutOfRange(maxConfidencePpm_);
        pyth = IPyth(pyth_);
        priceId = priceId_;
        maxAgeSeconds = maxAgeSeconds_;
        maxConfidencePpm = maxConfidencePpm_;
        description = description_;
    }

    /// @notice Answers are 8 decimal USD, matching GoldOracle's registration check.
    function decimals() external pure returns (uint8) {
        return 8;
    }

    /// @notice Interface version, for tooling that reads Chainlink style aggregators.
    function version() external pure returns (uint256) {
        return 1;
    }

    /// @notice The stored price in the AggregatorV3 shape. Never reverts; an unsafe price is answer 0
    ///         with every other field 0, so the oracle sees it as invalid on two counts.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint256 price, uint256 publishTime, Status status) = _read();
        if (status != Status.OK) return (0, 0, 0, 0, 0);
        roundId = uint80(publishTime);
        // price is at most MAX_USD_PRICE, so the cast cannot wrap.
        return (roundId, int256(price), publishTime, publishTime, roundId);
    }

    /// @notice The stored price with the reason behind it, for monitoring and diagnosis.
    /// @return answer 8 decimal USD price, 0 unless status is OK.
    /// @return status Why the answer is what it is.
    function readPrice() external view returns (uint256 answer, Status status) {
        (answer,, status) = _read();
    }

    /// @notice The fee updatePriceFeeds needs for these updates (0 on Ethereum mainnet today).
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return pyth.getUpdateFee(updateData);
    }

    /// @notice Relays signed Pyth updates. Permissionless: Pyth verifies the Wormhole signatures and
    ///         stores only a price newer than the one it holds, so the relayer chooses nothing but the
    ///         timing within the bounds documented above. Exactly getUpdateFee is forwarded and the
    ///         rest of msg.value is returned to the caller.
    /// @dev The refund is a low level call after the update has landed. A caller that rejects it (no
    ///      receive function, or one that reverts) cannot make the update fail: the excess is credited
    ///      to pendingRefunds and RefundFailed is emitted. Reentering through the refund gains nothing,
    ///      since this contract holds no state the update depends on.
    function updatePrice(bytes[] calldata updateData) external payable {
        uint256 fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);
        pyth.updatePriceFeeds{value: fee}(updateData);
        uint256 excess = msg.value - fee;
        if (excess > 0) {
            (bool sent,) = msg.sender.call{value: excess}("");
            if (!sent) {
                pendingRefunds[msg.sender] += excess;
                emit RefundFailed(msg.sender, excess);
                // Deferred, not refunded: the summary below reports what was actually paid back.
                excess = 0;
            }
        }
        emit PriceUpdated(msg.sender, fee, excess);
    }

    /// @notice Pays out a refund that could not be delivered during updatePrice.
    function claimRefund() external {
        uint256 amount = pendingRefunds[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingRefunds[msg.sender] = 0;
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert RefundTransferFailed(msg.sender, amount);
        emit RefundClaimed(msg.sender, amount);
    }

    /// @notice Converts a Pyth price to 8 decimals, for monitoring and tests; the same gates as the reads.
    /// @param price The Pyth price, as `price * 10^expo`.
    /// @param conf The confidence interval, in the same units as `price`.
    /// @param expo The exponent, MIN_EXPO to MAX_EXPO.
    function convert(int64 price, uint64 conf, int32 expo) public view returns (uint256 answer, Status status) {
        if (price <= 0) return (0, Status.INVALID_PRICE);
        if (expo < MIN_EXPO || expo > MAX_EXPO) return (0, Status.EXPONENT_OUT_OF_RANGE);
        uint256 raw = uint256(uint64(price));
        // conf / raw > maxConfidencePpm / 1e6, cross-multiplied so nothing is rounded: dividing
        // first floored the ratio to whole parts per million and let through an interval a
        // fraction above the cap. Neither side can overflow: conf is a uint64 and 1e6 is under
        // 2^20, raw is under 2^63 and maxConfidencePpm is at most MAX_CONFIDENCE_PPM_CAP.
        if (uint256(conf) * 1_000_000 > maxConfidencePpm * raw) return (0, Status.WIDE_CONFIDENCE);
        // 10^8 / 10^(-expo): a multiplication for exponents above -8 and a floor division below it.
        uint256 scale = 10 ** uint256(uint32(-expo));
        answer = Math.mulDiv(raw, 1e8, scale);
        if (answer == 0 || answer > MAX_USD_PRICE) return (0, Status.PRICE_OUT_OF_RANGE);
        return (answer, Status.OK);
    }

    /// @dev Reads the stored price and applies every gate: readable, positive, not from the future,
    ///      within maxAgeSeconds, within maxConfidencePpm, with a representable exponent and answer.
    ///      getPriceUnsafe makes no recency or confidence promise, so both are checked here on the
    ///      returned struct itself: the publish time against the clock and maxAgeSeconds, and the
    ///      confidence first against the price (an interval wider than the price is far beyond any
    ///      accepted bound, and the cut keeps the ppm arithmetic below in range), then exactly
    ///      against maxConfidencePpm in convert().
    function _read() private view returns (uint256 answer, uint256 publishTime, Status status) {
        try pyth.getPriceUnsafe(priceId) returns (PythStructs.Price memory price) {
            publishTime = price.publishTime;
            if (price.publishTime > block.timestamp) return (0, publishTime, Status.FUTURE_PUBLISH_TIME);
            if (block.timestamp - price.publishTime > maxAgeSeconds) return (0, publishTime, Status.STALE);
            if (price.price <= 0) return (0, publishTime, Status.INVALID_PRICE);
            if (price.conf > uint64(price.price)) return (0, publishTime, Status.WIDE_CONFIDENCE);
            (answer, status) = convert(price.price, price.conf, price.expo);
            return (answer, publishTime, status);
        } catch {
            return (0, 0, Status.FEED_FAILED);
        }
    }
}
