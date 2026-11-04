import { z } from 'zod';
import type { Hex } from 'viem';
import { createSignerServer } from './server';

/** Environment for the isolated signer (ADR-0015). Fails closed on anything invalid. */
const env = z
  .object({
    SIGNER_OPERATOR_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    SIGNER_HMAC_SECRET: z.string().min(32),
    SIGNER_RPC_URL: z.url(),
    SIGNER_CHAIN_ID: z.coerce.number().int().positive(),
    SIGNER_VAULT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    /** JSON: {"0xtoken": {"perTx": "1000000000", "daily": "10000000000"}} in token minor units. */
    SIGNER_LIMITS: z.string(),
    SIGNER_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
    SIGNER_MIN_COMMIT_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(10),
    SIGNER_AUDIT_FILE: z.string().default('/data/signer-audit.jsonl'),
    PORT: z.coerce.number().int().default(4100),
    HOST: z.string().default('0.0.0.0'),
  })
  .parse(process.env);

const limits = new Map(
  Object.entries(
    JSON.parse(env.SIGNER_LIMITS) as Record<string, { perTx: string; daily: string }>,
  ).map(([token, l]) => [token.toLowerCase(), { perTx: BigInt(l.perTx), daily: BigInt(l.daily) }]),
);

createSignerServer({
  operatorKey: env.SIGNER_OPERATOR_KEY as Hex,
  hmacSecret: env.SIGNER_HMAC_SECRET,
  rpcUrl: env.SIGNER_RPC_URL,
  policy: {
    chainId: env.SIGNER_CHAIN_ID,
    vault: env.SIGNER_VAULT_ADDRESS.toLowerCase(),
    limits,
    maxTtlSeconds: env.SIGNER_MAX_TTL_SECONDS,
  },
  auditFile: env.SIGNER_AUDIT_FILE,
  minCommitIntervalSeconds: env.SIGNER_MIN_COMMIT_INTERVAL_SECONDS,
}).listen(env.PORT, env.HOST, () => {
  process.stdout.write(
    `signer listening on ${env.HOST}:${env.PORT} (policy: ${limits.size} tokens)\n`,
  );
});
