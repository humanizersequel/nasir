// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {ITempoSessionEscrow} from "./interfaces/ITempoSessionEscrow.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 value) external returns (bool);
}

contract LotPayee {
    error OnlyAuctionHouse();
    error WinnerAlreadyLocked();
    error WinnerNotLocked();
    error AlreadyExecuted();
    error InvalidChannelPayee();
    error InvalidChannelToken();
    error ChannelAlreadyFinalized();
    error ChannelAlreadySettled();
    error InsufficientChannelDeposit();
    error InsufficientCumulativeAmount();
    error TokenTransferFailed();

    address public immutable escrowContract;
    address public immutable quoteToken;
    address public immutable treasury;
    address public immutable auctionHouse;
    bytes32 public immutable lotId;

    bytes32 public winnerChannelId;
    address public winnerPayer;
    uint128 public clearingPrice;
    bool public executed;

    event WinnerLocked(
        bytes32 indexed lotId,
        bytes32 indexed winnerChannelId,
        address indexed winnerPayer,
        uint128 clearingPrice
    );
    event WinnerExecuted(
        bytes32 indexed lotId,
        bytes32 indexed winnerChannelId,
        uint128 cumulativeAmount,
        uint128 clearingPrice,
        uint128 refundAmount
    );

    modifier onlyAuctionHouse() {
        if (msg.sender != auctionHouse) revert OnlyAuctionHouse();
        _;
    }

    constructor(
        address escrowContract_,
        address quoteToken_,
        address treasury_,
        address auctionHouse_,
        bytes32 lotId_
    ) {
        escrowContract = escrowContract_;
        quoteToken = quoteToken_;
        treasury = treasury_;
        auctionHouse = auctionHouse_;
        lotId = lotId_;
    }

    function lockWinner(bytes32 winnerChannelId_, uint128 clearingPrice_) external onlyAuctionHouse {
        if (winnerChannelId != bytes32(0)) revert WinnerAlreadyLocked();

        ITempoSessionEscrow.Channel memory channel = ITempoSessionEscrow(escrowContract).getChannel(
            winnerChannelId_
        );

        if (channel.payee != address(this)) revert InvalidChannelPayee();
        if (channel.token != quoteToken) revert InvalidChannelToken();
        if (channel.finalized) revert ChannelAlreadyFinalized();
        if (channel.settled != 0) revert ChannelAlreadySettled();
        if (channel.deposit < clearingPrice_) revert InsufficientChannelDeposit();

        winnerChannelId = winnerChannelId_;
        clearingPrice = clearingPrice_;
        winnerPayer = channel.payer;

        emit WinnerLocked(lotId, winnerChannelId_, channel.payer, clearingPrice_);
    }

    function executeWinner(uint128 cumulativeAmount, bytes calldata signature) external {
        if (winnerChannelId == bytes32(0)) revert WinnerNotLocked();
        if (executed) revert AlreadyExecuted();
        if (cumulativeAmount < clearingPrice) revert InsufficientCumulativeAmount();

        executed = true;

        ITempoSessionEscrow(escrowContract).close(winnerChannelId, cumulativeAmount, signature);

        _safeTransfer(quoteToken, treasury, clearingPrice);

        uint128 refundAmount = cumulativeAmount - clearingPrice;
        if (refundAmount > 0) {
            _safeTransfer(quoteToken, winnerPayer, refundAmount);
        }

        emit WinnerExecuted(lotId, winnerChannelId, cumulativeAmount, clearingPrice, refundAmount);
    }

    function getSummary()
        external
        view
        returns (
            bytes32 lotId_,
            bytes32 winnerChannelId_,
            address winnerPayer_,
            uint128 clearingPrice_,
            bool executed_
        )
    {
        return (lotId, winnerChannelId, winnerPayer, clearingPrice, executed);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)
        );

        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
    }
}
