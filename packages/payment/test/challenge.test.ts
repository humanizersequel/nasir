import assert from "node:assert/strict";
import test from "node:test";

import { buildPaymentChallenge, formatPaymentAuthenticateHeader, parsePaymentAuthenticateHeader } from "../src/index";

test("buildPaymentChallenge is stable for identical inputs", () => {
  const first = buildPaymentChallenge({
    secret: "test-secret-0000000000000000",
    realm: "api.example.com",
    ttlSeconds: 90,
    now: new Date("2026-03-19T14:00:00.000Z"),
    body: {
      bidAmount: "1000000",
      channelIdHint: "0x1111111111111111111111111111111111111111111111111111111111111111"
    },
    request: {
      amount: "1",
      unitType: "bid-reserve-base-unit",
      suggestedDeposit: "1000000",
      currency: "0x0000000000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000002",
      methodDetails: {
        escrowContract: "0x0000000000000000000000000000000000000003",
        channelId: "0x1111111111111111111111111111111111111111111111111111111111111111",
        minVoucherDelta: "100000",
        feePayer: false,
        chainId: 42431
      }
    },
    opaque: {
      kind: "auction-bid",
      lotId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requestedBidAmount: "1000000",
      minNextBid: "1000000",
      auctionStateVersion: "42"
    }
  });

  const second = buildPaymentChallenge({
    secret: "test-secret-0000000000000000",
    realm: "api.example.com",
    ttlSeconds: 90,
    now: new Date("2026-03-19T14:00:00.000Z"),
    body: {
      bidAmount: "1000000",
      channelIdHint: "0x1111111111111111111111111111111111111111111111111111111111111111"
    },
    request: {
      amount: "1",
      unitType: "bid-reserve-base-unit",
      suggestedDeposit: "1000000",
      currency: "0x0000000000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000002",
      methodDetails: {
        escrowContract: "0x0000000000000000000000000000000000000003",
        channelId: "0x1111111111111111111111111111111111111111111111111111111111111111",
        minVoucherDelta: "100000",
        feePayer: false,
        chainId: 42431
      }
    },
    opaque: {
      kind: "auction-bid",
      lotId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requestedBidAmount: "1000000",
      minNextBid: "1000000",
      auctionStateVersion: "42"
    }
  });

  assert.equal(first.id, second.id);
  assert.equal(first.digest, second.digest);
});

test("challenge header round-trips through WWW-Authenticate parsing", () => {
  const challenge = buildPaymentChallenge({
    secret: "test-secret-0000000000000000",
    realm: "api.example.com",
    ttlSeconds: 90,
    now: new Date("2026-03-19T14:00:00.000Z"),
    body: { bidAmount: "2000000" },
    request: {
      amount: "1",
      unitType: "bid-reserve-base-unit",
      suggestedDeposit: "2000000",
      currency: "0x0000000000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000002",
      methodDetails: {
        escrowContract: "0x0000000000000000000000000000000000000003",
        minVoucherDelta: "100000",
        feePayer: false,
        chainId: 42431
      }
    },
    opaque: {
      kind: "auction-bid",
      lotId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      requestedBidAmount: "2000000",
      minNextBid: "2000000",
      auctionStateVersion: "43"
    }
  });

  const header = formatPaymentAuthenticateHeader(challenge);
  const parsed = parsePaymentAuthenticateHeader(header);

  assert.deepEqual(parsed, challenge);
});
