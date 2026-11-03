import { z } from 'zod';

/**
 * Environment validation.
 *
 * Every process validates its environment at boot and refuses to start on
 * invalid or unsafe configuration. Error messages name the offending variable
 * but never echo its value (values may be secrets).
 */

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/** Placeholder values shipped in `.env.example`; rejected outside development/test. */
const PLACEHOLDER_MARKERS = ['change-me', 'changeme', 'example', 'insecure', 'dev-only'];

const containsPlaceholder = (value: string): boolean =>
  PLACEHOLDER_MARKERS.some((marker) => value.toLowerCase().includes(marker));

const base64Key32 = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: 'must be a base64-encoded 32-byte key' },
);

export const DEPLOY_ENVIRONMENTS = ['local', 'ci', 'staging', 'production'] as const;
export type DeployEnvironment = (typeof DEPLOY_ENVIRONMENTS)[number];

export const MAIL_TRANSPORTS = ['log', 'memory'] as const;

export const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Logical deployment environment. Separates local/CI/staging/production behaviour. */
    DEPLOY_ENV: z.enum(DEPLOY_ENVIRONMENTS).default('local'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z
      .string()
      .url()
      .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
        message: 'must be a PostgreSQL connection URL',
      }),
    REDIS_URL: z
      .string()
      .url()
      .refine((v) => v.startsWith('redis://') || v.startsWith('rediss://'), {
        message: 'must be a redis:// or rediss:// URL',
      }),

    /** Public origin of the web application; used for links in emails and origin checks. */
    WEB_ORIGIN: z.string().url(),
    /**
     * Number of reverse-proxy hops in front of the API (Express `trust proxy`).
     * Must match the real topology, otherwise client IPs (rate limits, audit logs) are wrong.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

    SESSION_IDLE_TIMEOUT_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .default(30),
    SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(12),
    SESSION_COOKIE_SECURE: booleanString.default(true),

    CSRF_SECRET: z.string().min(32, 'must be at least 32 characters'),
    MFA_ENCRYPTION_KEY: base64Key32,

    ARGON2_MEMORY_KIB: z.coerce.number().int().min(19456).default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),

    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(10),
    LOGIN_LOCKOUT_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(15),

    RATE_LIMIT_DEFAULT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).default(10),

    MAIL_TRANSPORT: z.enum(MAIL_TRANSPORTS).default('log'),
    MAIL_FROM: z.string().min(3).default('no-reply@localhost'),

    SWAGGER_ENABLED: booleanString.default(false),

    /** Milliseconds between market-data change checks for WebSocket pushes; 0 disables pushes. */
    MARKET_DATA_POLL_MS: z.coerce.number().int().min(0).max(60_000).default(250),
    /** Seconds between scheduled ledger reconciliations; 0 disables the scheduler. */
    /** Milliseconds between settlement polls of engine events; 0 disables the poller. */
    SETTLEMENT_POLL_MS: z.coerce.number().int().min(0).max(60_000).default(250),
    LEDGER_RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),

    /** Display name used as the TOTP issuer and in emails. Temporary until the brand is final. */
    BRAND_NAME: z.string().min(1).max(40).default('Exchange'),
  })
  .superRefine((env, ctx) => {
    const strict = env.DEPLOY_ENV === 'staging' || env.DEPLOY_ENV === 'production';
    if (!strict) return;

    if (env.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['NODE_ENV'],
        message: `must be "production" when DEPLOY_ENV=${env.DEPLOY_ENV}`,
      });
    }
    if (!env.SESSION_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'must be true outside local/ci',
      });
    }
    if (!env.WEB_ORIGIN.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'must use https outside local/ci',
      });
    }
    for (const key of ['CSRF_SECRET', 'MFA_ENCRYPTION_KEY', 'DATABASE_URL', 'REDIS_URL'] as const) {
      if (containsPlaceholder(env[key])) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'contains a placeholder value from .env.example',
        });
      }
    }
    const mfaKey = Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64');
    if (new Set(mfaKey).size < 8) {
      ctx.addIssue({
        code: 'custom',
        path: ['MFA_ENCRYPTION_KEY'],
        message: 'looks degenerate (e.g. all zero bytes); generate with `openssl rand -base64 32`',
      });
    }
    // No production-grade mail transport is implemented yet (see docs/operations/known-issues.md).
    // Refuse to boot rather than silently dropping or logging security emails.
    if (env.MAIL_TRANSPORT === 'log' || env.MAIL_TRANSPORT === 'memory') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'development-only mail transport is not allowed outside local/ci',
      });
    }
    if (env.SWAGGER_ENABLED && env.DEPLOY_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['SWAGGER_ENABLED'],
        message: 'must be false in production',
      });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const webEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Internal URL the Next.js server uses to reach the API (server-side only). */
  API_INTERNAL_URL: z.string().url().default('http://localhost:4000'),
  /** Display brand. Temporary until the final brand is chosen; never used in business logic. */
  NEXT_PUBLIC_BRAND_NAME: z.string().min(1).max(40).default('Exchange'),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse and validate an environment object. Throws `EnvValidationError` listing
 * variable names and reasons only (never values).
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  // Treat empty strings as unset so defaults apply consistently.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
