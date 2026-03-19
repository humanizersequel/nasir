// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

interface ITempoSessionEscrow {
    struct Channel {
        address payer;
        address payee;
        address token;
        address authorizedSigner;
        uint128 deposit;
        uint128 settled;
        uint64 closeRequestedAt;
        bool finalized;
    }

    function getChannel(bytes32 channelId) external view returns (Channel memory);

    function computeChannelId(
        address payer,
        address payee,
        address token,
        bytes32 salt,
        address authorizedSigner
    ) external view returns (bytes32);

    function getVoucherDigest(bytes32 channelId, uint128 cumulativeAmount) external view returns (bytes32);

    function close(bytes32 channelId, uint128 cumulativeAmount, bytes calldata signature) external;
}
