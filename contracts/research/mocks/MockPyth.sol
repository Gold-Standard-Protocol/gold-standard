// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IPyth, PythStructs} from "../oracle/PythMarketFeed.sol";

/// @title MockPyth
/// @notice Test double for the Pyth contract: settable stored prices, a settable per update fee, and
///         an updatePriceFeeds that decodes a simple test encoding, `abi.encode(bytes32 id, int64 price,
///         uint64 conf, int32 expo, uint256 publishTime)` per update, and stores an update only when it
///         is newer than the stored price, as Pyth does. Records what it received.
contract MockPyth is IPyth {
    mapping(bytes32 => PythStructs.Price) private _prices;
    uint256 public feePerUpdate;
    bool public revertOnRead;
    bool public revertOnUpdate;

    uint256 public updateCalls;
    uint256 public updatesApplied;
    uint256 public feesReceived;
    bytes32 public lastUpdatedId;

    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        _prices[id] = PythStructs.Price(price, conf, expo, publishTime);
    }

    function setFeePerUpdate(uint256 fee) external {
        feePerUpdate = fee;
    }

    function setRevertOnRead(bool value) external {
        revertOnRead = value;
    }

    function setRevertOnUpdate(bool value) external {
        revertOnUpdate = value;
    }

    /// @notice The test encoding of one update.
    function encodeUpdate(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external pure returns (bytes memory) {
        return abi.encode(id, price, conf, expo, publishTime);
    }

    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory price) {
        require(!revertOnRead, "PriceFeedNotFound");
        return _prices[id];
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return feePerUpdate * updateData.length;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        require(!revertOnUpdate, "InvalidUpdateData");
        uint256 fee = feePerUpdate * updateData.length;
        require(msg.value >= fee, "InsufficientFee");
        updateCalls += 1;
        feesReceived += msg.value;
        for (uint256 i = 0; i < updateData.length; i++) {
            (bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) =
                abi.decode(updateData[i], (bytes32, int64, uint64, int32, uint256));
            if (publishTime > _prices[id].publishTime) {
                _prices[id] = PythStructs.Price(price, conf, expo, publishTime);
                updatesApplied += 1;
                lastUpdatedId = id;
            }
        }
    }
}
