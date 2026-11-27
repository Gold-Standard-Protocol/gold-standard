// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IGoldOracle {
    /// @notice Returns the PAXG/USD price with 8 decimals and the timestamp of the last update
    function getPaxgPrice() external view returns (uint256 price, uint256 updatedAt);

    /// @notice Returns the XAUT/USD price with 8 decimals and the timestamp of the last update
    function getXautPrice() external view returns (uint256 price, uint256 updatedAt);

    /// @notice The liquidation price for a collateral token, used both to decide whether a vault
    ///         is liquidatable and to size the seizure: with its market feed C and the gold
    ///         reference G both healthy, min(max(C, G), G x (1 + m)), m the token's liquidation
    ///         cap. Reverts "No reliable price" whenever C or G is unhealthy.
    /// @dev State-changing: records the price as the token's last known price.
    function getTokenPrice(address token) external returns (uint256 price);

    /// @notice What getTokenPrice would answer now, as a view, with the same reverts.
    function quoteTokenPrice(address token) external view returns (uint256 price);

    /// @notice The conservative valuation for borrowing: C and G healthy with C inside the
    ///         token's gold band, then the lower of the two. Reverts "Off gold band" outside the
    ///         band and "No reliable price" when a source has stopped. State-changing like
    ///         getTokenPrice.
    function getBorrowPrice(address token) external returns (uint256 price);

    /// @notice What getBorrowPrice would answer now, as a view, with the same reverts.
    function quoteBorrowPrice(address token) external view returns (uint256 price);

    /// @notice The reserve swap price: the borrowing gate (C and G healthy, C inside the gold
    ///         band), then the higher of C and G, so reserve gold never sells below gold or below
    ///         the market. Same reverts as getBorrowPrice. State-changing like getTokenPrice.
    function getReservePrice(address token) external returns (uint256 price);

    /// @notice What getReservePrice would answer now, as a view, with the same reverts.
    function quoteReservePrice(address token) external view returns (uint256 price);

    /// @notice The price the reserve values its gold at for coverage: the lower of C and G when
    ///         both are healthy, 0 when either has stopped. Never reverts for a supported token,
    ///         paused or frozen alike; reverts "Unsupported token" otherwise.
    function quoteValuationPrice(address token) external view returns (uint256 price);

    /// @notice Returns the last known price for a token (works even when paused)
    function getLastKnownPrice(address token) external view returns (uint256 price);

    /// @notice Validated read of the token's market feed that works even while paused; ok=false
    ///         if the feed data fails any integrity/staleness check (instead of reverting).
    function getValidatedPrice(address token) external view returns (uint256 price, bool ok);

    /// @notice True while the guardian or governance holds `token` frozen (a freeze lapses
    ///         after 14 days unless extended): its normal reads revert, so every
    ///         risk-increasing operation in that token stops while other tokens run, and its
    ///         emergency price is refused, during a pause as well.
    function tokenFrozen(address token) external view returns (bool);

    /// @notice The price an emergency liquidation of `token` collateral is sized at.
    /// @dev Only while `vaultPaused` or the oracle pause holds: the normal liquidation price,
    ///      or "No price" whenever the rules give none. It reverts "Token frozen" for a frozen
    ///      token in every case, a pause included, and "Not in emergency" outside a pause.
    function getEmergencyPrice(address token, bool vaultPaused) external view returns (uint256 price);

    /// @notice Whether the oracle is paused. Part of the interface because
    ///         GoldVault.emergencyLiquidate depends on it: any oracle implementation
    ///         wired into the vault MUST expose Pausable semantics.
    function paused() external view returns (bool);
}
