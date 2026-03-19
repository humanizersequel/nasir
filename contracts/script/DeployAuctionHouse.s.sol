// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script} from "forge-std/Script.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";

contract DeployAuctionHouseScript is Script {
    function run() external returns (AuctionHouse house) {
        address escrowContract = vm.envAddress("ESCROW_CONTRACT");
        address quoteToken = vm.envAddress("QUOTE_TOKEN");
        address treasury = vm.envAddress("TREASURY");
        address owner = vm.envAddress("OWNER");
        address operator = vm.envAddress("OPERATOR");

        vm.startBroadcast();
        house = new AuctionHouse(escrowContract, quoteToken, treasury, owner, operator);
        vm.stopBroadcast();
    }
}
