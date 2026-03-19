import { z } from "zod";

import { addressPattern } from "@nasir/shared";

const lowerAddressSchema = z
  .string()
  .regex(addressPattern)
  .transform((value) => value.toLowerCase());

const apiOriginSchema = z.string().url();

export const webEnvSchema = z.object({
  NEXT_PUBLIC_API_ORIGIN: apiOriginSchema,
  NEXT_PUBLIC_CHAIN_ID: z.coerce.number().int().positive(),
  NEXT_PUBLIC_ESCROW_ADDRESS: lowerAddressSchema,
  NEXT_PUBLIC_AUCTION_HOUSE_ADDRESS: lowerAddressSchema,
  NEXT_PUBLIC_QUOTE_TOKEN_ADDRESS: lowerAddressSchema
});

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  RPC_URL: z.string().url(),
  MPP_CHALLENGE_SECRET: z.string().min(16),
  AUCTION_HOUSE_ADDRESS: lowerAddressSchema,
  ESCROW_ADDRESS: lowerAddressSchema,
  QUOTE_TOKEN_ADDRESS: lowerAddressSchema,
  CORS_ORIGINS: z.string().min(1),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(90)
});

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  RPC_URL: z.string().url(),
  OPERATOR_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  AUCTION_HOUSE_ADDRESS: lowerAddressSchema,
  ESCROW_ADDRESS: lowerAddressSchema,
  QUOTE_TOKEN_ADDRESS: lowerAddressSchema
});

export type WebEnv = z.infer<typeof webEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWebEnv(env: Record<string, string | undefined> = process.env): WebEnv {
  return webEnvSchema.parse(env);
}

export function loadApiEnv(env: Record<string, string | undefined> = process.env): ApiEnv {
  return apiEnvSchema.parse(env);
}

export function loadWorkerEnv(env: Record<string, string | undefined> = process.env): WorkerEnv {
  return workerEnvSchema.parse(env);
}

export function splitCorsOrigins(rawOrigins: string): string[] {
  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
