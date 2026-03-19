// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {ITempoSessionEscrow} from "../src/interfaces/ITempoSessionEscrow.sol";
import {LotPayee} from "../src/LotPayee.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockEscrow is ITempoSessionEscrow {
    mapping(bytes32 => Channel) internal _channels;
    mapping(bytes32 => bool) public closed;

    function setChannel(bytes32 channelId, Channel calldata channel) external {
        _channels[channelId] = channel;
    }

    function getChannel(bytes32 channelId) external view returns (Channel memory) {
        return _channels[channelId];
    }

    function computeChannelId(
        address payer,
        address payee,
        address token,
        bytes32 salt,
        address authorizedSigner
    ) external view returns (bytes32) {
        return keccak256(abi.encode(payer, payee, token, salt, authorizedSigner, address(this), block.chainid));
    }

    function getVoucherDigest(bytes32 channelId, uint128 cumulativeAmount) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(channelId, cumulativeAmount));
    }

    function close(bytes32 channelId, uint128 cumulativeAmount, bytes calldata) external {
        require(!closed[channelId], "already closed");
        closed[channelId] = true;

        Channel memory channel = _channels[channelId];
        MockERC20(channel.token).transfer(msg.sender, cumulativeAmount);
    }
}

contract AuctionHouseTest is Test {
    bytes32 internal constant LOT_ID = keccak256("lot-1");
    bytes32 internal constant CH_ID = keccak256("winner-channel");

    address internal owner = address(0xA11CE);
    address internal operator = address(0xB0B);
    address internal payer = address(0xCAFE);
    address internal treasury = address(0xD00D);

    MockERC20 internal token;
    MockEscrow internal escrow;
    AuctionHouse internal house;

    function setUp() public {
        token = new MockERC20();
        escrow = new MockEscrow();
        house = new AuctionHouse(address(escrow), address(token), treasury, owner, operator);
    }

    function test_CreateCloseAndExecuteWinner() public {
        vm.prank(operator);
        address lotPayee = house.createAuction(LOT_ID, keccak256("meta"));

        ITempoSessionEscrow.Channel memory channel = ITempoSessionEscrow.Channel({
            payer: payer,
            payee: lotPayee,
            token: address(token),
            authorizedSigner: address(0),
            deposit: 1_000,
            settled: 0,
            closeRequestedAt: 0,
            finalized: false
        });
        escrow.setChannel(CH_ID, channel);
        token.mint(address(escrow), 1_000);

        vm.prank(operator);
        house.closeAuction(LOT_ID, CH_ID, 700);

        LotPayee(lotPayee).executeWinner(900, hex"1234");

        assertEq(token.balanceOf(treasury), 700);
        assertEq(token.balanceOf(payer), 200);
        (, , , , bool executed) = LotPayee(lotPayee).getSummary();
        assertTrue(executed);
    }

    function test_CannotExecuteTwice() public {
        vm.prank(operator);
        address lotPayee = house.createAuction(LOT_ID, bytes32(0));

        ITempoSessionEscrow.Channel memory channel = ITempoSessionEscrow.Channel({
            payer: payer,
            payee: lotPayee,
            token: address(token),
            authorizedSigner: address(0),
            deposit: 1_000,
            settled: 0,
            closeRequestedAt: 0,
            finalized: false
        });
        escrow.setChannel(CH_ID, channel);
        token.mint(address(escrow), 1_000);

        vm.prank(operator);
        house.closeAuction(LOT_ID, CH_ID, 100);
        LotPayee(lotPayee).executeWinner(200, hex"");

        vm.expectRevert(LotPayee.AlreadyExecuted.selector);
        LotPayee(lotPayee).executeWinner(200, hex"");
    }

    function test_CloseAuctionRevertsWhenChannelDepositBelowClearingPrice() public {
        vm.prank(operator);
        address lotPayee = house.createAuction(LOT_ID, bytes32(0));

        ITempoSessionEscrow.Channel memory channel = ITempoSessionEscrow.Channel({
            payer: payer,
            payee: lotPayee,
            token: address(token),
            authorizedSigner: address(0),
            deposit: 500,
            settled: 0,
            closeRequestedAt: 0,
            finalized: false
        });
        escrow.setChannel(CH_ID, channel);

        vm.prank(operator);
        vm.expectRevert(LotPayee.InsufficientChannelDeposit.selector);
        house.closeAuction(LOT_ID, CH_ID, 700);
    }
}
