import type { AuctionRepository } from "@nasir/db";
import type { ApiEnv } from "@nasir/config";
import { Store } from "mppx";
import type { Session } from "mppx/tempo";

import { DEFAULT_CHAIN_ID } from "./constants";

type PersistedSessionState = {
  authorizedSigner: string;
  chainId: number;
  escrowContract: string;
  channelId: string;
  closeRequestedAt: string | null;
  createdAt: string;
  deposit: string;
  finalized: boolean;
  highestVoucher: {
    channelId: string;
    cumulativeAmount: string;
    signature: string;
  } | null;
  highestVoucherAmount: string;
  payee: string;
  payer: string;
  settledOnChain: string;
  spent: string;
  token: string;
  units: number;
};

function serializeSessionState(state: Session.ChannelStore.State): string {
  const maybeCloseRequestedState = state as Session.ChannelStore.State & {
    closeRequestedAt?: bigint;
  };
  const persisted: PersistedSessionState = {
    authorizedSigner: state.authorizedSigner.toLowerCase(),
    chainId: state.chainId,
    escrowContract: state.escrowContract.toLowerCase(),
    channelId: state.channelId.toLowerCase(),
    closeRequestedAt: maybeCloseRequestedState.closeRequestedAt?.toString() ?? null,
    createdAt: state.createdAt,
    deposit: state.deposit.toString(),
    finalized: state.finalized,
    highestVoucher: state.highestVoucher
      ? {
          channelId: state.highestVoucher.channelId.toLowerCase(),
          cumulativeAmount: state.highestVoucher.cumulativeAmount.toString(),
          signature: state.highestVoucher.signature
        }
      : null,
    highestVoucherAmount: state.highestVoucherAmount.toString(),
    payee: state.payee.toLowerCase(),
    payer: state.payer.toLowerCase(),
    settledOnChain: state.settledOnChain.toString(),
    spent: state.spent.toString(),
    token: state.token.toLowerCase(),
    units: state.units
  };

  return JSON.stringify(persisted);
}

function deserializeSessionState(raw: string): Session.ChannelStore.State {
  const persisted = JSON.parse(raw) as PersistedSessionState;

  return {
    authorizedSigner: persisted.authorizedSigner as `0x${string}`,
    chainId: persisted.chainId,
    escrowContract: persisted.escrowContract as `0x${string}`,
    channelId: persisted.channelId as `0x${string}`,
    closeRequestedAt: persisted.closeRequestedAt ? BigInt(persisted.closeRequestedAt) : 0n,
    createdAt: persisted.createdAt,
    deposit: BigInt(persisted.deposit),
    finalized: persisted.finalized,
    highestVoucher: persisted.highestVoucher
      ? {
          channelId: persisted.highestVoucher.channelId as `0x${string}`,
          cumulativeAmount: BigInt(persisted.highestVoucher.cumulativeAmount),
          signature: persisted.highestVoucher.signature as `0x${string}`
        }
      : null,
    highestVoucherAmount: BigInt(persisted.highestVoucherAmount),
    payee: persisted.payee as `0x${string}`,
    payer: persisted.payer as `0x${string}`,
    settledOnChain: BigInt(persisted.settledOnChain),
    spent: BigInt(persisted.spent),
    token: persisted.token as `0x${string}`,
    units: persisted.units
  } as Session.ChannelStore.State;
}

function tryReconstructSessionState(parameters: {
  channel: Awaited<ReturnType<AuctionRepository["getChannel"]>>;
  env: ApiEnv;
  lotPayee: string;
}): Session.ChannelStore.State | null {
  const { channel, env, lotPayee } = parameters;
  if (!channel) {
    return null;
  }

  if (!channel.latestVoucherAmount || !channel.latestVoucherSig) {
    return null;
  }

  return {
    authorizedSigner: (channel.authorizedSigner ?? channel.payer) as `0x${string}`,
    chainId: DEFAULT_CHAIN_ID,
    escrowContract: env.ESCROW_ADDRESS as `0x${string}`,
    channelId: channel.channelId as `0x${string}`,
    closeRequestedAt: channel.closeRequestedAt ? BigInt(channel.closeRequestedAt) : 0n,
    createdAt: channel.createdAt.toISOString(),
    deposit: BigInt(channel.deposit),
    finalized: channel.finalized,
    highestVoucher: {
      channelId: channel.channelId as `0x${string}`,
      cumulativeAmount: BigInt(channel.latestVoucherAmount),
      signature: channel.latestVoucherSig as `0x${string}`
    },
    highestVoucherAmount: BigInt(channel.latestVoucherAmount),
    payee: lotPayee as `0x${string}`,
    payer: channel.payer as `0x${string}`,
    settledOnChain: BigInt(channel.settled),
    spent: 0n,
    token: env.QUOTE_TOKEN_ADDRESS as `0x${string}`,
    units: 0
  } as Session.ChannelStore.State;
}

export function createRepositoryBackedPaymentStore(repository: AuctionRepository, env: ApiEnv) {
  return Store.from({
    async get<value = unknown>(key: string) {
      const channel = await repository.getChannel(key.toLowerCase());
      if (channel?.sessionState) {
        return deserializeSessionState(channel.sessionState) as value;
      }

      if (!channel) {
        return null;
      }

      const lot = await repository.getLotById(channel.lotId);
      const reconstructed = lot
        ? tryReconstructSessionState({
            channel,
            env,
            lotPayee: lot.lotPayee.toLowerCase()
          })
        : null;

      return (reconstructed ?? null) as value;
    },

    async put(key: string, value: unknown) {
      const state = value as Session.ChannelStore.State;
      const maybeCloseRequestedState = state as Session.ChannelStore.State & {
        closeRequestedAt?: bigint;
      };
      const existing = await repository.getChannel(key.toLowerCase());
      const lotId =
        existing?.lotId ??
        (await repository.getLotByPayee(state.payee.toLowerCase()))?.lotId;

      if (!lotId) {
        throw new Error(`No lot found for channel payee ${state.payee}.`);
      }

      await repository.upsertChannelSnapshot({
        channelId: key.toLowerCase(),
        lotId,
        payer: state.payer.toLowerCase(),
        authorizedSigner: state.authorizedSigner.toLowerCase(),
        deposit: state.deposit.toString(),
        settled: state.settledOnChain.toString(),
        finalized: state.finalized,
        closeRequestedAt: maybeCloseRequestedState.closeRequestedAt ?? null,
        latestVoucherAmount: state.highestVoucherAmount.toString(),
        latestVoucherSig: state.highestVoucher?.signature ?? null,
        sessionState: serializeSessionState(state)
      });
    },

    async delete(key: string) {
      await repository.clearChannelSessionState(key.toLowerCase());
    }
  });
}

export function buildJsonRequest(parameters: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}) {
  return new Request(parameters.url, {
    method: parameters.method,
    headers: parameters.headers,
    ...(parameters.body === undefined
      ? {}
      : {
          body: JSON.stringify(parameters.body)
        })
  });
}
