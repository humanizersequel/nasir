import { readEscrowChannel } from "@nasir/chain";
import type { ApiEnv } from "@nasir/config";
import { AuctionRepository } from "@nasir/db";
import {
  buildPaymentChallenge,
  buildPaymentReceipt,
  createProblemDetails,
  encodePaymentReceiptHeader,
  formatPaymentAuthenticateHeader,
  hashRequestForIdempotency,
  parsePaymentAuthorizationHeader,
  assertSupportedBidAction,
  verifyPaymentChallenge,
  verifyVoucherSignature
} from "@nasir/payment";
import {
  acceptedBidResponseSchema,
  listLotsResponseSchema,
  lotDetailSchema,
  lotStatusResponseSchema,
  placeBidRequestSchema,
  type AcceptedBidResponse,
  type LotDetail,
  type LotStatusResponse,
  type PlaceBidRequest
} from "@nasir/shared";
import type { PublicClient } from "viem";

import { DEFAULT_CHAIN_ID, ZERO_ADDRESS } from "./constants";

type CachedResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

type BuildChallengeResult = {
  headerValue: string;
  challengeId: string;
};

type PaidBidResult = CachedResponse;

export class ApiService {
  constructor(
    private readonly env: ApiEnv,
    private readonly repository: AuctionRepository,
    private readonly publicClient: PublicClient
  ) {}

  async listLots() {
    const lots = await this.repository.listLots();
    return listLotsResponseSchema.parse({
      lots: lots.map((lot) => this.mapLotSummary(lot))
    });
  }

  async getLot(lotId: string): Promise<LotDetail | null> {
    const lot = await this.repository.getLotById(lotId.toLowerCase());
    return lot ? this.mapLotDetail(lot) : null;
  }

  async getLotStatus(lotId: string): Promise<LotStatusResponse | null> {
    const lot = await this.repository.getLotStatus(lotId.toLowerCase());
    if (!lot) {
      return null;
    }

    return lotStatusResponseSchema.parse({
      lotId: lot.lotId,
      status: lot.status,
      currentHighBidAmount: lot.currentHighBidAmount,
      currentHighChannelId: lot.currentHighChannelId,
      minNextBid: lot.minNextBid,
      endsAt: lot.endsAt?.toISOString() ?? null
    });
  }

  async handleBidRequest(input: {
    lotId: string;
    idempotencyKey: string;
    body: unknown;
    authorizationHeader?: string;
    realm: string;
    apiOrigin: string;
  }): Promise<PaidBidResult> {
    const normalizedLotId = input.lotId.toLowerCase();
    const body = placeBidRequestSchema.parse(input.body);
    const requestHash = hashRequestForIdempotency(body);

    const cached = await this.repository.findIdempotency(`/v1/lots/${normalizedLotId}/bids`, input.idempotencyKey);
    if (cached) {
      if (cached.requestHash !== requestHash) {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "idempotency-conflict",
          title: "Idempotency Conflict",
          status: 409,
          detail: "The supplied Idempotency-Key was previously used with a different request body.",
          lotId: normalizedLotId
        });

        return {
          status: 409,
          headers: {},
          body: problem
        };
      }

      return {
        status: cached.responseStatus,
        headers: cached.responseHeaders as Record<string, string>,
        body: cached.responseBody
      };
    }

    const lotRow = await this.requireLot(normalizedLotId, input.apiOrigin);
    this.assertLotCanAcceptBid(lotRow.status, body.bidAmount, lotRow.minNextBid, normalizedLotId, input.apiOrigin);

    const authorization = parsePaymentAuthorizationHeader(input.authorizationHeader);
    if (!authorization) {
      const challenge = await this.buildBidChallenge({
        lot: lotRow,
        body,
        realm: input.realm
      });
      const problem = createProblemDetails({
        apiOrigin: input.apiOrigin,
        slug: "payment-required",
        title: "Payment Required",
        status: 402,
        detail: "Retry the same request with Authorization: Payment after preparing the required Tempo session credential.",
        lotId: normalizedLotId
      });

      return {
        status: 402,
        headers: {
          "WWW-Authenticate": challenge.headerValue,
          "Cache-Control": "no-store"
        },
        body: problem
      };
    }

    try {
      verifyPaymentChallenge({
        secret: this.env.MPP_CHALLENGE_SECRET,
        challenge: authorization.challenge,
        body,
        realm: input.realm
      });
      const payload = assertSupportedBidAction(authorization.payload);

      if (payload.action !== "voucher") {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "channel-funding-managed-onchain",
          title: "Channel Funding Must Be Managed Onchain",
          status: 403,
          detail:
            "This deployment accepts voucher-backed bid retries only. Open and topUp should be performed directly against the Tempo session escrow contract before retrying with action=voucher.",
          lotId: normalizedLotId
        });

        return {
          status: 403,
          headers: {},
          body: problem
        };
      }

      if (payload.cumulativeAmount !== body.bidAmount) {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "invalid-voucher-amount",
          title: "Invalid Voucher Amount",
          status: 403,
          detail: "For v0, voucher cumulativeAmount must equal the requested bidAmount exactly.",
          lotId: normalizedLotId
        });

        return {
          status: 403,
          headers: {},
          body: problem
        };
      }

      const storedChannel = await this.repository.getChannel(payload.channelId);
      const onchainChannel = await this.readChannelFromChain(payload.channelId);
      if (!onchainChannel) {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "channel-not-found",
          title: "Channel Not Found",
          status: 410,
          detail: "The referenced channel is unknown or no longer available for bidding.",
          lotId: normalizedLotId,
          channelId: payload.channelId
        });

        return {
          status: 410,
          headers: {},
          body: problem
        };
      }

      if (onchainChannel.payee.toLowerCase() !== lotRow.lotPayee.toLowerCase()) {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "wrong-channel-payee",
          title: "Wrong Channel Payee",
          status: 403,
          detail: "The referenced channel does not belong to this lot payee.",
          lotId: normalizedLotId,
          channelId: payload.channelId
        });

        return {
          status: 403,
          headers: {},
          body: problem
        };
      }

      if (onchainChannel.token.toLowerCase() !== this.env.QUOTE_TOKEN_ADDRESS.toLowerCase()) {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "wrong-channel-token",
          title: "Wrong Channel Token",
          status: 403,
          detail: "The referenced channel token does not match the auction quote token.",
          lotId: normalizedLotId,
          channelId: payload.channelId
        });

        return {
          status: 403,
          headers: {},
          body: problem
        };
      }

      if (onchainChannel.finalized) {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "channel-gone",
          title: "Channel Unavailable",
          status: 410,
          detail: "The referenced channel cannot be used for this lot.",
          lotId: normalizedLotId,
          channelId: payload.channelId
        });

        return {
          status: 410,
          headers: {},
          body: problem
        };
      }

      const closeRequestedAt = onchainChannel.closeRequestedAt === 0n ? null : onchainChannel.closeRequestedAt;

      if (closeRequestedAt) {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "channel-close-requested",
          title: "Channel Closing",
          status: 403,
          detail: "Channels with a pending close request cannot be used to place bids.",
          lotId: normalizedLotId,
          channelId: payload.channelId
        });

        return {
          status: 403,
          headers: {},
          body: problem
        };
      }

      const normalizedPayer = onchainChannel.payer.toLowerCase();
      const normalizedAuthorizedSigner =
        onchainChannel.authorizedSigner.toLowerCase() === ZERO_ADDRESS ? null : onchainChannel.authorizedSigner.toLowerCase();
      const deposit = onchainChannel.deposit.toString();
      const settled = onchainChannel.settled.toString();

      await this.repository.upsertChannelSnapshot({
        channelId: payload.channelId,
        lotId: normalizedLotId,
        payer: normalizedPayer,
        authorizedSigner: normalizedAuthorizedSigner,
        deposit,
        settled,
        finalized: onchainChannel.finalized,
        closeRequestedAt,
        latestVoucherAmount: storedChannel?.latestVoucherAmount ?? null,
        latestVoucherSig: storedChannel?.latestVoucherSig ?? null
      });

      if (payload.payer.toLowerCase() !== normalizedPayer) {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "payer-mismatch",
          title: "Payer Mismatch",
          status: 403,
          detail: "The voucher payload payer does not match the on-chain channel payer.",
          lotId: normalizedLotId,
          channelId: payload.channelId
        });

        return {
          status: 403,
          headers: {},
          body: problem
        };
      }

      if (BigInt(deposit) < BigInt(body.bidAmount)) {
        const challenge = await this.buildBidChallenge({
          lot: lotRow,
          body,
          realm: input.realm
        });
        const requiredTopUp = (BigInt(body.bidAmount) - BigInt(deposit)).toString();
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "session/insufficient-balance",
          title: "Insufficient Authorized Balance",
          status: 402,
          detail: "The current authorization does not cover the requested bid.",
          lotId: normalizedLotId,
          requiredBidAmount: body.bidAmount,
          requiredTopUp,
          channelId: payload.channelId
        });

        return {
          status: 402,
          headers: {
            "WWW-Authenticate": challenge.headerValue,
            "Cache-Control": "no-store"
          },
          body: problem
        };
      }

      if (storedChannel?.latestVoucherAmount && BigInt(payload.cumulativeAmount) <= BigInt(storedChannel.latestVoucherAmount)) {
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "voucher-not-higher",
          title: "Voucher Not Higher",
          status: 403,
          detail: "Voucher cumulativeAmount must be strictly greater than the previously accepted voucher for this channel.",
          lotId: normalizedLotId,
          channelId: payload.channelId
        });

        return {
          status: 403,
          headers: {},
          body: problem
        };
      }

      const expectedSigner =
        normalizedAuthorizedSigner && normalizedAuthorizedSigner !== ZERO_ADDRESS
          ? normalizedAuthorizedSigner
          : normalizedPayer;

      const validSignature = await verifyVoucherSignature({
        escrowContract: this.env.ESCROW_ADDRESS as `0x${string}`,
        chainId: DEFAULT_CHAIN_ID,
        channelId: payload.channelId as `0x${string}`,
        cumulativeAmount: payload.cumulativeAmount,
        signature: payload.signature as `0x${string}`,
        expectedSigner: expectedSigner as `0x${string}`
      });

      if (!validSignature) {
        const challenge = await this.buildBidChallenge({
          lot: lotRow,
          body,
          realm: input.realm
        });
        const problem = createProblemDetails({
          apiOrigin: input.apiOrigin,
          slug: "invalid-voucher-signature",
          title: "Invalid Voucher Signature",
          status: 402,
          detail: "The provided voucher signature does not match the channel signer.",
          lotId: normalizedLotId,
          channelId: payload.channelId
        });

        return {
          status: 402,
          headers: {
            "WWW-Authenticate": challenge.headerValue,
            "Cache-Control": "no-store"
          },
          body: problem
        };
      }

      const nextMinBid = (BigInt(body.bidAmount) + BigInt(lotRow.bidIncrement)).toString();
      await this.repository.recordAcceptedBid({
        lotId: normalizedLotId,
        channelId: payload.channelId,
        payer: normalizedPayer,
        authorizedSigner: normalizedAuthorizedSigner,
        deposit,
        settled,
        finalized: onchainChannel.finalized,
        closeRequestedAt,
        bidAmount: body.bidAmount,
        nextMinBid,
        signature: payload.signature
      });

      const responseBody = acceptedBidResponseSchema.parse({
        lotId: normalizedLotId,
        status: "accepted",
        channelId: payload.channelId,
        payer: payload.payer,
        bidAmount: body.bidAmount,
        currentHighBidAmount: body.bidAmount,
        minNextBid: nextMinBid,
        lotStatus: "OPEN"
      });

      const receipt = buildPaymentReceipt({
        challengeId: authorization.challenge.id,
        channelId: payload.channelId,
        acceptedCumulative: body.bidAmount,
        spent: "0",
        reservedBidAmount: body.bidAmount,
        standing: "highest",
        lotId: normalizedLotId
      });

      const headers = {
        "Payment-Receipt": encodePaymentReceiptHeader(receipt),
        "Cache-Control": "private"
      };

      await this.repository.saveIdempotency(`/v1/lots/${normalizedLotId}/bids`, input.idempotencyKey, requestHash, {
        status: 200,
        headers,
        body: responseBody
      });

      return {
        status: 200,
        headers,
        body: responseBody
      };
    } catch (error) {
      const challenge = await this.buildBidChallenge({
        lot: lotRow,
        body,
        realm: input.realm
      });
      const problem = createProblemDetails({
        apiOrigin: input.apiOrigin,
        slug: "invalid-payment-credential",
        title: "Invalid Payment Credential",
        status: 402,
        detail: error instanceof Error ? error.message : "The supplied Authorization: Payment credential was invalid.",
        lotId: normalizedLotId
      });

      return {
        status: 402,
        headers: {
          "WWW-Authenticate": challenge.headerValue,
          "Cache-Control": "no-store"
        },
        body: problem
      };
    }
  }

  private async requireLot(lotId: string, apiOrigin: string) {
    const lot = await this.repository.getLotById(lotId);
    if (!lot) {
      throw createProblemDetails({
        apiOrigin,
        slug: "lot-not-found",
        title: "Lot Not Found",
        status: 404,
        detail: "No lot exists for the supplied lotId.",
        lotId
      });
    }

    return lot;
  }

  private assertLotCanAcceptBid(
    status: string,
    bidAmount: string,
    minNextBid: string,
    lotId: string,
    apiOrigin: string
  ) {
    if (status !== "OPEN") {
      throw createProblemDetails({
        apiOrigin,
        slug: "lot-closed",
        title: "Lot Closed",
        status: 403,
        detail: "This lot is not open for bidding.",
        lotId
      });
    }

    if (BigInt(bidAmount) < BigInt(minNextBid)) {
      throw createProblemDetails({
        apiOrigin,
        slug: "bid-too-low",
        title: "Bid Too Low",
        status: 403,
        detail: "Bid must be at least the next increment.",
        lotId,
        minNextBid
      });
    }
  }

  private async buildBidChallenge(input: {
    lot: Awaited<ReturnType<AuctionRepository["getLotById"]>> extends infer T ? NonNullable<T> : never;
    body: PlaceBidRequest;
    realm: string;
  }): Promise<{ challenge: ReturnType<typeof buildPaymentChallenge>; headerValue: string; challengeId: string }> {
    const hintedChannelId = input.body.channelIdHint?.toLowerCase();
    const hintedOnchainChannel = hintedChannelId ? await this.readChannelFromChain(hintedChannelId) : null;
    const canReuseHintedChannel =
      hintedChannelId &&
      hintedOnchainChannel &&
      hintedOnchainChannel.payee.toLowerCase() === input.lot.lotPayee.toLowerCase() &&
      hintedOnchainChannel.token.toLowerCase() === this.env.QUOTE_TOKEN_ADDRESS.toLowerCase() &&
      !hintedOnchainChannel.finalized &&
      hintedOnchainChannel.closeRequestedAt === 0n;

    if (hintedChannelId && hintedOnchainChannel && canReuseHintedChannel) {
      await this.repository.upsertChannelSnapshot({
        channelId: hintedChannelId,
        lotId: input.lot.lotId,
        payer: hintedOnchainChannel.payer.toLowerCase(),
        authorizedSigner:
          hintedOnchainChannel.authorizedSigner.toLowerCase() === ZERO_ADDRESS
            ? null
            : hintedOnchainChannel.authorizedSigner.toLowerCase(),
        deposit: hintedOnchainChannel.deposit.toString(),
        settled: hintedOnchainChannel.settled.toString(),
        finalized: hintedOnchainChannel.finalized,
        closeRequestedAt: null
      });
    }

    const challenge = buildPaymentChallenge({
      secret: this.env.MPP_CHALLENGE_SECRET,
      realm: input.realm,
      body: input.body,
      ttlSeconds: this.env.CHALLENGE_TTL_SECONDS,
      request: {
        amount: "1",
        unitType: "bid-reserve-base-unit",
        suggestedDeposit: input.body.bidAmount,
        currency: this.env.QUOTE_TOKEN_ADDRESS,
        recipient: input.lot.lotPayee as `0x${string}`,
        methodDetails: {
          escrowContract: this.env.ESCROW_ADDRESS,
          ...(canReuseHintedChannel
            ? {
                channelId: hintedChannelId as `0x${string}`
              }
            : {}),
          minVoucherDelta: input.lot.bidIncrement,
          feePayer: false,
          chainId: DEFAULT_CHAIN_ID
        }
      },
      opaque: {
        kind: "auction-bid",
        lotId: input.lot.lotId as `0x${string}`,
        requestedBidAmount: input.body.bidAmount,
        minNextBid: input.lot.minNextBid,
        auctionStateVersion: this.buildAuctionStateVersion(input.lot)
      }
    });

    return {
      challenge,
      challengeId: challenge.id,
      headerValue: formatPaymentAuthenticateHeader(challenge)
    };
  }

  private buildAuctionStateVersion(lot: {
    currentHighBidAmount: string | null;
    currentHighChannelId: string | null;
    updatedAt: Date;
  }) {
    return [lot.updatedAt.getTime(), lot.currentHighBidAmount ?? "0", lot.currentHighChannelId ?? "none"].join(":");
  }

  private mapLotSummary(lot: Awaited<ReturnType<AuctionRepository["listLots"]>>[number]) {
    return {
      lotId: lot.lotId,
      externalLotId: lot.externalLotId,
      title: lot.title,
      status: lot.status,
      currentHighBidAmount: lot.currentHighBidAmount,
      minNextBid: lot.minNextBid,
      bidIncrement: lot.bidIncrement,
      endsAt: lot.endsAt?.toISOString() ?? null
    };
  }

  private mapLotDetail(lot: Awaited<ReturnType<AuctionRepository["getLotById"]>> extends infer T ? NonNullable<T> : never) {
    return lotDetailSchema.parse({
      ...this.mapLotSummary(lot),
      description: lot.description,
      lotPayee: lot.lotPayee,
      auctionHouse: this.env.AUCTION_HOUSE_ADDRESS,
      escrowContract: this.env.ESCROW_ADDRESS,
      quoteToken: this.env.QUOTE_TOKEN_ADDRESS,
      chainId: DEFAULT_CHAIN_ID,
      currentHighChannelId: lot.currentHighChannelId
    });
  }

  private async readChannelFromChain(channelId: string) {
    const channel = await readEscrowChannel(
      this.publicClient,
      this.env.ESCROW_ADDRESS as `0x${string}`,
      channelId as `0x${string}`
    );

    return channel.payer.toLowerCase() === ZERO_ADDRESS ? null : channel;
  }
}
