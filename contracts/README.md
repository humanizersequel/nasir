# Auction + Tempo Session Contracts

This folder contains a single-use payee pattern for auction settlement on top of Tempo session channels.

## Contract Overview

- `src/AuctionHouse.sol`
  - Registry + factory (no separate factory contract).
  - Creates exactly one `LotPayee` per `lotId`.
  - Stores auction state and operator permissions.
  - Locks winner channel + clearing price at close time.

- `src/LotPayee.sol`
  - Dedicated payee contract for one lot.
  - Accepts exactly one winner lock from `AuctionHouse`.
  - Performs exactly one downstream escrow `close(...)`.
  - Forwards `clearingPrice` to treasury and refunds over-authorization to winning payer.

- `src/interfaces/ITempoSessionEscrow.sol`
  - Minimal interface aligned to deployed `TempoStreamChannel` ABI:
    - `getChannel(...)`
    - `computeChannelId(...)`
    - `getVoucherDigest(...)`
    - `close(...)`

## High-Level Flow

1. Operator calls `createAuction(lotId, metadataHash)` on `AuctionHouse`.
2. `AuctionHouse` deploys a new `LotPayee` for that lot.
3. Bidders open Tempo channels where `payee = lotPayee`.
4. Off-chain bidding happens with Tempo voucher signatures.
5. Operator closes auction with `closeAuction(lotId, winnerChannelId, clearingPrice)`.
6. `LotPayee.lockWinner(...)` validates the winning channel against escrow state.
7. Anyone can call `LotPayee.executeWinner(cumulativeAmount, signature)` once:
   - calls escrow `close(...)`
   - sends `clearingPrice` to `treasury`
   - refunds `cumulativeAmount - clearingPrice` to winning payer

## AuctionHouse State Model

`AuctionStatus`:
- `NONE`: lot not created
- `OPEN`: lot active
- `WINNER_LOCKED`: winner selected and locked
- `CANCELLED`: lot cancelled with no winner execution path

`Auction`:
- `lotPayee`: per-lot payee contract address
- `metadataHash`: optional off-chain metadata pointer hash
- `winnerChannelId`: set on close
- `clearingPrice`: set on close
- `status`: enum above

## Trust and Pricing Model

- The on-chain contracts **do not discover price**.
- `clearingPrice` is defined by an allowed operator in `closeAuction(...)`.
- On-chain logic enforces safety and consistency only:
  - locked winner channel must belong to the lot payee
  - token must match `quoteToken`
  - channel must be unfinalized and unsettled at lock time
  - channel `deposit >= clearingPrice`
  - execution can happen only once

## Critical Invariants

- No generic execution or arbitrary call surface in `LotPayee`.
- No upgrade hooks.
- `LotPayee` never calls `settle()`.
- `LotPayee` can perform at most one escrow `close()`.
- `executed` is set before external escrow interaction in `executeWinner()`.

## Deploy

Deploy one `AuctionHouse` per:
- Tempo escrow contract
- quote token
- treasury

Required env vars:
- `ESCROW_CONTRACT`
- `QUOTE_TOKEN`
- `TREASURY`
- `OWNER`
- `OPERATOR`

Command:

```shell
ESCROW_CONTRACT=<escrow> \
QUOTE_TOKEN=<token> \
TREASURY=<treasury> \
OWNER=<owner> \
OPERATOR=<operator> \
forge script script/DeployAuctionHouse.s.sol:DeployAuctionHouseScript \
  --rpc-url <your_rpc_url> \
  --private-key <your_private_key> \
  --broadcast
```

## Development

```shell
forge build
forge test
```
