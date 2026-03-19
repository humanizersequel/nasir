// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {LotPayee} from "./LotPayee.sol";

contract AuctionHouse {
    error OnlyOwner();
    error OnlyOperator();
    error AuctionAlreadyExists();
    error AuctionNotOpen();
    error InvalidWinnerChannel();

    enum AuctionStatus {
        NONE,
        OPEN,
        WINNER_LOCKED,
        CANCELLED
    }

    struct Auction {
        address lotPayee;
        bytes32 metadataHash;
        bytes32 winnerChannelId;
        uint128 clearingPrice;
        AuctionStatus status;
    }

    mapping(bytes32 => Auction) public auctions;

    address public immutable escrowContract;
    address public immutable quoteToken;
    address public immutable treasury;
    address public owner;
    mapping(address => bool) public operators;

    event AuctionCreated(bytes32 indexed lotId, address indexed lotPayee, bytes32 metadataHash);
    event AuctionClosed(bytes32 indexed lotId, bytes32 indexed winnerChannelId, uint128 clearingPrice);
    event AuctionCancelled(bytes32 indexed lotId);
    event OperatorSet(address indexed operator, bool allowed);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert OnlyOperator();
        _;
    }

    constructor(
        address escrowContract_,
        address quoteToken_,
        address treasury_,
        address owner_,
        address operator_
    ) {
        escrowContract = escrowContract_;
        quoteToken = quoteToken_;
        treasury = treasury_;
        owner = owner_;

        operators[operator_] = true;
        emit OperatorSet(operator_, true);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function createAuction(bytes32 lotId, bytes32 metadataHash) external onlyOperator returns (address lotPayee) {
        Auction storage auction = auctions[lotId];
        if (auction.status != AuctionStatus.NONE) revert AuctionAlreadyExists();

        lotPayee = address(
            new LotPayee(escrowContract, quoteToken, treasury, address(this), lotId)
        );

        auctions[lotId] = Auction({
            lotPayee: lotPayee,
            metadataHash: metadataHash,
            winnerChannelId: bytes32(0),
            clearingPrice: 0,
            status: AuctionStatus.OPEN
        });

        emit AuctionCreated(lotId, lotPayee, metadataHash);
    }

    function closeAuction(
        bytes32 lotId,
        bytes32 winnerChannelId,
        uint128 clearingPrice
    ) external onlyOperator {
        Auction storage auction = auctions[lotId];
        if (auction.status != AuctionStatus.OPEN) revert AuctionNotOpen();
        if (winnerChannelId == bytes32(0)) revert InvalidWinnerChannel();

        auction.winnerChannelId = winnerChannelId;
        auction.clearingPrice = clearingPrice;
        auction.status = AuctionStatus.WINNER_LOCKED;

        LotPayee(auction.lotPayee).lockWinner(winnerChannelId, clearingPrice);

        emit AuctionClosed(lotId, winnerChannelId, clearingPrice);
    }

    function cancelAuction(bytes32 lotId) external onlyOperator {
        Auction storage auction = auctions[lotId];
        if (auction.status != AuctionStatus.OPEN) revert AuctionNotOpen();

        auction.status = AuctionStatus.CANCELLED;
        emit AuctionCancelled(lotId);
    }

    function getAuction(bytes32 lotId) external view returns (Auction memory) {
        return auctions[lotId];
    }
}
