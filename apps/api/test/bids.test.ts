import assert from "node:assert/strict";
import test from "node:test";

import { buildVoucherTypedData } from "@nasir/chain";
import { apiEnvSchema } from "@nasir/config";
import { encodeBase64UrlJson, parsePaymentAuthenticateHeader } from "@nasir/payment";
import { privateKeyToAccount } from "viem/accounts";

import { buildApiApp } from "../src/app";

const lotId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const channelId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const payerKey = "0x59c6995e998f97a5a0044966f0945382d7d58f7d9b5ecfd1f1c3f1e7a4e4b1c3" as const;
const payerAccount = privateKeyToAccount(payerKey);

function createEnv() {
  return apiEnvSchema.parse({
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: "postgres://unused",
    RPC_URL: "https://rpc.moderato.tempo.xyz",
    MPP_CHALLENGE_SECRET: "test-secret-0000000000000000",
    AUCTION_HOUSE_ADDRESS: "0x0000000000000000000000000000000000000011",
    ESCROW_ADDRESS: "0x0000000000000000000000000000000000000022",
    QUOTE_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000033",
    CORS_ORIGINS: "http://localhost:3001",
    CHALLENGE_TTL_SECONDS: 90
  });
}

function createRepository() {
  const lot = {
    id: "lot-row",
    lotId,
    externalLotId: "LOT-1",
    title: "Vintage Camera",
    description: "Test lot",
    lotPayee: "0x0000000000000000000000000000000000000044",
    status: "OPEN",
    currentHighBidAmount: null,
    currentHighChannelId: null,
    minNextBid: "1000",
    bidIncrement: "100",
    winnerChannelId: null,
    winningBidAmount: null,
    createTxHash: null,
    closeTxHash: null,
    executeTxHash: null,
    endsAt: null,
    createdAt: new Date("2026-03-19T12:00:00.000Z"),
    updatedAt: new Date("2026-03-19T12:00:00.000Z")
  };

  const channels = new Map<string, any>();
  const idempotency = new Map<string, any>();

  return {
    async listLots() {
      return [lot];
    },
    async getLotById(requestedLotId: string) {
      return requestedLotId === lotId ? lot : null;
    },
    async getLotStatus(requestedLotId: string) {
      return requestedLotId === lotId
        ? {
            lotId: lot.lotId,
            status: lot.status,
            currentHighBidAmount: lot.currentHighBidAmount,
            currentHighChannelId: lot.currentHighChannelId,
            minNextBid: lot.minNextBid,
            endsAt: lot.endsAt
          }
        : null;
    },
    async findIdempotency(route: string, key: string) {
      return idempotency.get(`${route}:${key}`) ?? null;
    },
    async saveIdempotency(route: string, key: string, requestHash: string, response: any) {
      idempotency.set(`${route}:${key}`, {
        route,
        idempotencyKey: key,
        requestHash,
        responseStatus: response.status,
        responseHeaders: response.headers,
        responseBody: response.body
      });
    },
    async getChannel(requestedChannelId: string) {
      return channels.get(requestedChannelId) ?? null;
    },
    async upsertChannelSnapshot(input: any) {
      channels.set(input.channelId, {
        channelId: input.channelId,
        lotId: input.lotId,
        payer: input.payer,
        authorizedSigner: input.authorizedSigner,
        deposit: input.deposit,
        settled: input.settled,
        finalized: input.finalized,
        closeRequestedAt: input.closeRequestedAt,
        latestVoucherAmount: input.latestVoucherAmount ?? null,
        latestVoucherSig: input.latestVoucherSig ?? null,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    },
    async recordAcceptedBid(input: any) {
      lot.currentHighBidAmount = input.bidAmount;
      lot.currentHighChannelId = input.channelId;
      lot.minNextBid = input.nextMinBid;
      channels.set(input.channelId, {
        channelId: input.channelId,
        lotId: input.lotId,
        payer: input.payer,
        authorizedSigner: input.authorizedSigner,
        deposit: input.deposit,
        settled: input.settled,
        finalized: input.finalized,
        closeRequestedAt: input.closeRequestedAt,
        latestVoucherAmount: input.bidAmount,
        latestVoucherSig: input.signature,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      return lot;
    }
  };
}

function createPublicClient(env: ReturnType<typeof createEnv>) {
  return {
    async readContract() {
      return {
        payer: payerAccount.address,
        payee: "0x0000000000000000000000000000000000000044",
        token: env.QUOTE_TOKEN_ADDRESS,
        authorizedSigner: "0x0000000000000000000000000000000000000000",
        deposit: 2_000n,
        settled: 0n,
        closeRequestedAt: 0n,
        finalized: false
      };
    }
  };
}

test("POST /bids returns 402 then accepts a voucher retry", async () => {
  const env = createEnv();
  const repository = createRepository();
  const app = buildApiApp({
    env,
    repository: repository as never,
    publicClient: createPublicClient(env) as never
  });

  const firstResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-1",
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  assert.equal(firstResponse.statusCode, 402);
  assert.equal(firstResponse.headers["cache-control"], "no-store");
  const challenge = parsePaymentAuthenticateHeader(firstResponse.headers["www-authenticate"]);
  assert.ok(challenge);

  const signature = await payerAccount.signTypedData(
    buildVoucherTypedData({
      escrowContract: env.ESCROW_ADDRESS,
      chainId: 42431,
      channelId,
      cumulativeAmount: "1000"
    })
  );

  const secondResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-1",
      authorization: `Payment ${encodeBase64UrlJson({
        challenge,
        payload: {
          action: "voucher",
          channelId,
          payer: payerAccount.address,
          cumulativeAmount: "1000",
          signature
        }
      })}`,
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  assert.equal(secondResponse.statusCode, 200);
  assert.ok(secondResponse.headers["payment-receipt"]);
  assert.deepEqual(secondResponse.json(), {
    lotId,
    status: "accepted",
    channelId,
    payer: payerAccount.address.toLowerCase(),
    bidAmount: "1000",
    currentHighBidAmount: "1000",
    minNextBid: "1100",
    lotStatus: "OPEN"
  });

  await app.close();
});

test("accepted bid responses are replayed through idempotency", async () => {
  const env = createEnv();
  const repository = createRepository();
  const app = buildApiApp({
    env,
    repository: repository as never,
    publicClient: createPublicClient(env) as never
  });

  const firstResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-cache",
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  const challenge = parsePaymentAuthenticateHeader(firstResponse.headers["www-authenticate"]);
  assert.ok(challenge);

  const signature = await payerAccount.signTypedData(
    buildVoucherTypedData({
      escrowContract: env.ESCROW_ADDRESS,
      chainId: 42431,
      channelId,
      cumulativeAmount: "1000"
    })
  );

  const paidResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-cache",
      authorization: `Payment ${encodeBase64UrlJson({
        challenge,
        payload: {
          action: "voucher",
          channelId,
          payer: payerAccount.address,
          cumulativeAmount: "1000",
          signature
        }
      })}`,
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  const replayedResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-cache",
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  assert.equal(paidResponse.statusCode, 200);
  assert.equal(replayedResponse.statusCode, 200);
  assert.deepEqual(replayedResponse.json(), paidResponse.json());
  assert.equal(replayedResponse.headers["payment-receipt"], paidResponse.headers["payment-receipt"]);

  await app.close();
});

test("challenge/body mismatch returns 402 with a fresh challenge", async () => {
  const env = createEnv();
  const repository = createRepository();
  const app = buildApiApp({
    env,
    repository: repository as never,
    publicClient: createPublicClient(env) as never
  });

  const firstResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-digest",
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  const challenge = parsePaymentAuthenticateHeader(firstResponse.headers["www-authenticate"]);
  assert.ok(challenge);

  const signature = await payerAccount.signTypedData(
    buildVoucherTypedData({
      escrowContract: env.ESCROW_ADDRESS,
      chainId: 42431,
      channelId,
      cumulativeAmount: "1100"
    })
  );

  const secondResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-digest",
      authorization: `Payment ${encodeBase64UrlJson({
        challenge,
        payload: {
          action: "voucher",
          channelId,
          payer: payerAccount.address,
          cumulativeAmount: "1100",
          signature
        }
      })}`,
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1100",
      channelIdHint: channelId
    }
  });

  assert.equal(secondResponse.statusCode, 402);
  assert.ok(secondResponse.headers["www-authenticate"]);
  assert.match(String(secondResponse.json().detail), /digest mismatch/i);

  await app.close();
});

test("open and topUp are rejected in favor of direct onchain funding", async () => {
  const env = createEnv();
  const repository = createRepository();
  const app = buildApiApp({
    env,
    repository: repository as never,
    publicClient: createPublicClient(env) as never
  });

  const firstResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-topup",
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  const challenge = parsePaymentAuthenticateHeader(firstResponse.headers["www-authenticate"]);
  assert.ok(challenge);

  const secondResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-topup",
      authorization: `Payment ${encodeBase64UrlJson({
        challenge,
        payload: {
          action: "topUp",
          channelId,
          payer: payerAccount.address,
          topUpAmount: "100",
          topUpTx: {
            to: env.ESCROW_ADDRESS,
            data: "0x1234"
          }
        }
      })}`,
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  assert.equal(secondResponse.statusCode, 403);
  assert.match(String(secondResponse.json().detail), /performed directly against the Tempo session escrow contract/i);

  await app.close();
});

test("close is rejected on the bid route", async () => {
  const env = createEnv();
  const repository = createRepository();
  const app = buildApiApp({
    env,
    repository: repository as never,
    publicClient: createPublicClient(env) as never
  });

  const firstResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-close",
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  const challenge = parsePaymentAuthenticateHeader(firstResponse.headers["www-authenticate"]);
  assert.ok(challenge);

  const secondResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-close",
      authorization: `Payment ${encodeBase64UrlJson({
        challenge,
        payload: {
          action: "close"
        }
      })}`,
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  assert.equal(secondResponse.statusCode, 403);
  assert.match(String(secondResponse.json().detail), /voucher-backed bid retries only/i);

  await app.close();
});

test("health, discovery, and free lot reads are exposed for agents", async () => {
  const env = createEnv();
  const repository = createRepository();
  const app = buildApiApp({
    env,
    repository: repository as never,
    publicClient: createPublicClient(env) as never
  });

  const health = await app.inject({
    method: "GET",
    url: "/healthz",
    headers: {
      host: "api.example.com"
    }
  });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { ok: true });

  const openapi = await app.inject({
    method: "GET",
    url: "/openapi.json",
    headers: {
      host: "api.example.com"
    }
  });
  assert.equal(openapi.statusCode, 200);
  assert.equal(openapi.json().paths["/v1/lots/{lotId}/bids"].post["x-payment-info"].method, "tempo");

  const llms = await app.inject({
    method: "GET",
    url: "/llms.txt",
    headers: {
      host: "api.example.com"
    }
  });
  assert.equal(llms.statusCode, 200);
  assert.match(llms.body, /Authorization: Payment/);

  const lots = await app.inject({
    method: "GET",
    url: "/v1/lots",
    headers: {
      host: "api.example.com"
    }
  });
  assert.equal(lots.statusCode, 200);
  assert.equal(lots.json().lots[0].lotId, lotId);

  const detail = await app.inject({
    method: "GET",
    url: `/v1/lots/${lotId}`,
    headers: {
      host: "api.example.com"
    }
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().lotPayee, "0x0000000000000000000000000000000000000044");

  const status = await app.inject({
    method: "GET",
    url: `/v1/lots/${lotId}/status`,
    headers: {
      host: "api.example.com"
    }
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().minNextBid, "1000");

  await app.close();
});

test("idempotency key reuse with a different request hash returns 409", async () => {
  const env = createEnv();
  const repository = createRepository();
  const app = buildApiApp({
    env,
    repository: repository as never,
    publicClient: createPublicClient(env) as never
  });

  const firstResponse = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-conflict",
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });

  const challenge = parsePaymentAuthenticateHeader(firstResponse.headers["www-authenticate"]);
  assert.ok(challenge);

  const signature = await payerAccount.signTypedData(
    buildVoucherTypedData({
      escrowContract: env.ESCROW_ADDRESS,
      chainId: 42431,
      channelId,
      cumulativeAmount: "1000"
    })
  );

  const accepted = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-conflict",
      authorization: `Payment ${encodeBase64UrlJson({
        challenge,
        payload: {
          action: "voucher",
          channelId,
          payer: payerAccount.address,
          cumulativeAmount: "1000",
          signature
        }
      })}`,
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1000",
      channelIdHint: channelId
    }
  });
  assert.equal(accepted.statusCode, 200);

  const conflict = await app.inject({
    method: "POST",
    url: `/v1/lots/${lotId}/bids`,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bid-conflict",
      host: "api.example.com"
    },
    payload: {
      bidAmount: "1100",
      channelIdHint: channelId
    }
  });

  assert.equal(conflict.statusCode, 409);
  assert.match(String(conflict.json().detail), /previously used with a different request body/i);

  await app.close();
});
