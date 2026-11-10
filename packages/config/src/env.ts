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

/**
 * Restricted jurisdictions approved by counsel (ADR-0024): the United States
 * and Ontario, plus territories under comprehensive sanctions (Cuba, Iran,
 * North Korea, Crimea, Sevastopol, Donetsk, Luhansk). Overridable by env.
 */
export const DEFAULT_RESTRICTED_COUNTRIES = 'US,CU,IR,KP';
export const DEFAULT_RESTRICTED_SUBDIVISIONS = 'CA-ON,UA-43,UA-40,UA-14,UA-09';

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

    /** Per-user order commands (place/cancel/reduce) per second; abuse protection. */
    ORDER_RATE_LIMIT_PER_SECOND: z.coerce.number().int().min(1).max(100_000).default(10),
    /** Maximum open orders per user per market. */
    MAX_OPEN_ORDERS_PER_MARKET: z.coerce.number().int().min(1).max(1_000_000).default(200),
    /** Milliseconds between market-data change checks for WebSocket pushes; 0 disables pushes. */
    MARKET_DATA_POLL_MS: z.coerce.number().int().min(0).max(60_000).default(250),
    /** Seconds between scheduled ledger reconciliations; 0 disables the scheduler. */
    /** Milliseconds between settlement polls of engine events; 0 disables the poller. */
    SETTLEMENT_POLL_MS: z.coerce.number().int().min(0).max(60_000).default(250),
    /** Milliseconds between perpetual risk ticks (index/mark, funding, liquidation); 0 disables. */
    PERP_RISK_POLL_MS: z.coerce.number().int().min(0).max(60_000).default(1000),
    /** Share of a referred account's taker fees paid to its referrer, basis points (ADR-0018). */
    REFERRAL_FEE_SHARE_BPS: z.coerce.number().int().min(0).max(5000).default(1000),
    /** Days after the referred account's creation during which the share is paid. */
    REFERRAL_DURATION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
    /**
     * Quote assets whose traded notional counts towards fee tiers and points
     * (comma-separated codes; empty = every asset whose code contains "USD").
     */
    FEE_VOLUME_QUOTE_ASSETS: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean),
      ),
    /** Seconds between fee-tier and points recomputations; 0 disables the job. */
    GROWTH_JOB_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(3600),
    /** Milliseconds between TWAP / iceberg steps; 0 disables (ADR-0020). */
    ALGO_POLL_MS: z.coerce.number().int().min(0).max(60_000).default(1000),
    /** Milliseconds between dead-man-switch checks (cancel-after timers); 0 disables. */
    CANCEL_TIMER_POLL_MS: z.coerce.number().int().min(0).max(60_000).default(1000),
    LEDGER_RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),

    /** Display name used as the TOTP issuer and in emails. Temporary until the brand is final. */
    BRAND_NAME: z.string().min(1).max(40).default('Exchange'),

    /** Staff permissions require MFA on the account (ADR-0012). Cannot be disabled outside local/ci. */
    STAFF_MFA_REQUIRED: booleanString.default(true),
    /** Seconds a step-up (fresh authenticator code) stays valid for sensitive staff actions. */
    STEP_UP_WINDOW_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    /** Comma-separated CIDRs; when set, staff permissions are only usable from these addresses. */
    ADMIN_IP_ALLOWLIST: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      ),
    /** Hours before an unanswered maker-checker request expires. */
    APPROVAL_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    /**
     * ISO 3166-1 alpha-2 codes (comma-separated) of restricted jurisdictions
     * (ADR-0024: list approved by counsel). Also refused at identity verification.
     */
    RESTRICTED_COUNTRIES: z
      .string()
      .default(DEFAULT_RESTRICTED_COUNTRIES)
      .transform((v) =>
        v
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[A-Z]{2}$/))),
    /**
     * Request header carrying the client's ISO 3166-1 alpha-2 country, set by
     * the edge proxy/CDN (e.g. "cf-ipcountry"). The proxy MUST overwrite any
     * client-sent value. Empty = region checks off (local/ci only, ADR-0022).
     */
    GEO_COUNTRY_HEADER: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^([a-z0-9-]{1,64})?$/)
      .default(''),
    /**
     * Request header carrying the client's ISO 3166-2 subdivision, set by the
     * edge (Cloudflare's "cf-region-code" sends "ON" for Ontario). Needed only
     * when RESTRICTED_SUBDIVISIONS is set. Same overwrite rule as above.
     */
    GEO_REGION_HEADER: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^([a-z0-9-]{1,64})?$/)
      .default(''),
    /**
     * ISO 3166-2 codes (comma-separated, e.g. "CA-ON") restricted within an
     * otherwise permitted country. Legal input required (ADR-0023).
     */
    RESTRICTED_SUBDIVISIONS: z
      .string()
      .default(DEFAULT_RESTRICTED_SUBDIVISIONS)
      .transform((v) =>
        v
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/))),
    /**
     * What a restricted location may still do (ADR-0024).
     * block_all: nothing; the interface and API refuse every request except the
     * public access status (counsel's decision; funds stay withdrawable through
     * the vault contract's escape hatch). reduce_only: sign in, close, cancel
     * and withdraw stay open (ADR-0022).
     */
    GEO_RESTRICTED_MODE: z.enum(['block_all', 'reduce_only']).default('block_all'),
    /** What to do when the country (or a needed subdivision) is missing or invalid. */
    GEO_UNKNOWN_COUNTRY: z.enum(['allow', 'deny']).default('allow'),
    /**
     * Hours between automatic downloads of OFAC's SDN list (ADR-0023). 0 = off
     * (local/ci). Production requires 1-24.
     */
    SANCTIONS_SYNC_HOURS: z.coerce.number().int().min(0).max(168).default(0),
    /** Official source of the SDN list. Only https URLs are accepted. */
    SANCTIONS_OFAC_URL: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://'), 'must be an https URL')
      .default(
        'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV',
      ),
    /**
     * Asset the account overview values balances in (ADR-0028), e.g. a USD
     * stablecoin. Other assets are valued at the last trade of their spot
     * market against it; assets without one are shown unvalued.
     */
    VALUATION_ASSET: z
      .string()
      .regex(/^[A-Z0-9]{2,16}$/)
      .default('USDC'),
    /**
     * Treasury wallet that receives withdrawn fee revenue (ADR-0031), e.g. a
     * multisig the operator controls. Empty = treasury withdrawals disabled.
     * Set only here, never from the admin console, so a compromised staff
     * account cannot redirect revenue.
     */
    TREASURY_ADDRESS: z
      .string()
      .trim()
      .regex(/^(0x[0-9a-fA-F]{40})?$/, 'must be a 0x address')
      .default(''),
    /** Current terms-of-use version; trading requires accepting it (ADR-0022). */
    TERMS_VERSION: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,32}$/)
      .default('draft-2'),
    /**
     * Identity verification module (ADR-0013: off by default; customers sign in
     * with a wallet and are never asked for identity documents). The module
     * stays available for jurisdictions where an operator must enable it.
     */
    KYC_ENABLED: booleanString.default(false),
    /** Real (non-paper) trading requires KYC level ≥ 1 when true (needs KYC_ENABLED). */
    KYC_REQUIRED_FOR_REAL_TRADING: booleanString.default(false),
    /** 32-byte base64 key for identity data at rest. Falls back to MFA_ENCRYPTION_KEY only in local/ci. */
    PII_ENCRYPTION_KEY: z.string().optional(),
    /**
     * Vault integration (ADR-0014). Unset CHAIN_RPC_URL disables it. Testnets and
     * local chains only: mainnet chain ids are refused by the chain module.
     */
    CHAIN_RPC_URL: z.url().optional(),
    /** Operator key (signs withdrawals, commits state). Local/ci only; a signing service is required elsewhere. */
    CHAIN_OPERATOR_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    /** Isolated signer service (ADR-0015); required outside local/ci when the vault is enabled. */
    SIGNER_URL: z.url().optional(),
    SIGNER_HMAC_SECRET: z.string().min(32).optional(),
    CHAIN_CONFIRMATIONS: z.coerce.number().int().min(0).max(100).default(2),
    /** Milliseconds between indexer ticks; 0 disables the indexer. */
    CHAIN_POLL_MS: z.coerce.number().int().min(0).max(600_000).default(2000),
    /** Seconds between balance commitments to the vault; 0 disables the committer. */
    VAULT_STATE_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
    VAULT_WITHDRAWAL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
    /** Local chain only: gas + test tokens for a connected wallet. */
    CHAIN_FAUCET_ENABLED: booleanString.default(false),
    /**
     * REAL-VALUE networks (ADR-0038). Off by default: only test networks are
     * accepted. On: only MAINNET_NETWORKS are accepted, in production only,
     * with a deposit cap on every token and a deep confirmation count.
     */
    CHAIN_MAINNET: booleanString.default(false),
    /** Bearer token for GET /metrics (Prometheus). Unset = endpoint disabled. */
    METRICS_TOKEN: z.string().min(32).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.CHAIN_MAINNET) {
      if (env.DEPLOY_ENV !== 'production')
        ctx.addIssue({ code: 'custom', path: ['CHAIN_MAINNET'], message: 'production only' });
      if (!env.CHAIN_RPC_URL)
        ctx.addIssue({
          code: 'custom',
          path: ['CHAIN_RPC_URL'],
          message: 'required with CHAIN_MAINNET',
        });
      if (env.CHAIN_CONFIRMATIONS < 20)
        ctx.addIssue({
          code: 'custom',
          path: ['CHAIN_CONFIRMATIONS'],
          message: 'must be at least 20 with real funds',
        });
    }
    if (env.SIGNER_URL && !env.SIGNER_HMAC_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNER_HMAC_SECRET'],
        message: 'required with SIGNER_URL',
      });
    }
    if (env.KYC_REQUIRED_FOR_REAL_TRADING && !env.KYC_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['KYC_REQUIRED_FOR_REAL_TRADING'],
        message: 'requires KYC_ENABLED=true',
      });
    }
    const strict = env.DEPLOY_ENV === 'staging' || env.DEPLOY_ENV === 'production';
    if (!strict) return;

    if (env.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['NODE_ENV'],
        message: `must be "production" when DEPLOY_ENV=${env.DEPLOY_ENV}`,
      });
    }
    if (env.CHAIN_RPC_URL && !env.SIGNER_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SIGNER_URL'],
        message: 'the vault needs the isolated signer service outside local/ci (ADR-0015)',
      });
    }
    if (env.CHAIN_OPERATOR_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHAIN_OPERATOR_KEY'],
        message: 'raw operator keys are local/ci only; use a signing service (HSM/KMS) elsewhere',
      });
    }
    if (env.CHAIN_FAUCET_ENABLED) {
      ctx.addIssue({ code: 'custom', path: ['CHAIN_FAUCET_ENABLED'], message: 'local/ci only' });
    }
    if (env.CHAIN_RPC_URL && env.CHAIN_CONFIRMATIONS < 5) {
      // Public chains reorganise; deposits are credited only after this depth (ADR-0034).
      ctx.addIssue({
        code: 'custom',
        path: ['CHAIN_CONFIRMATIONS'],
        message: 'must be at least 5 on a public chain',
      });
    }
    if (!env.PII_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['PII_ENCRYPTION_KEY'],
        message: 'is required outside local/ci (separate from MFA_ENCRYPTION_KEY)',
      });
    }
    if (!env.STAFF_MFA_REQUIRED) {
      ctx.addIssue({
        code: 'custom',
        path: ['STAFF_MFA_REQUIRED'],
        message: 'must be true outside local/ci',
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
    // Region restrictions must be enforceable outside local/ci (ADR-0022).
    if (env.RESTRICTED_COUNTRIES.length > 0 && !env.GEO_COUNTRY_HEADER) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEO_COUNTRY_HEADER'],
        message: 'required when RESTRICTED_COUNTRIES is set',
      });
    }
    if (env.RESTRICTED_SUBDIVISIONS.length > 0 && !env.GEO_REGION_HEADER) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEO_REGION_HEADER'],
        message: 'required when RESTRICTED_SUBDIVISIONS is set',
      });
    }
    if (env.DEPLOY_ENV === 'production') {
      if (env.SANCTIONS_SYNC_HOURS < 1 || env.SANCTIONS_SYNC_HOURS > 24)
        ctx.addIssue({
          code: 'custom',
          path: ['SANCTIONS_SYNC_HOURS'],
          message: 'must be between 1 and 24 in production (daily screening list updates)',
        });
      if (env.RESTRICTED_COUNTRIES.length === 0)
        ctx.addIssue({
          code: 'custom',
          path: ['RESTRICTED_COUNTRIES'],
          message: 'must list the restricted jurisdictions in production (legal input)',
        });
      if (env.GEO_UNKNOWN_COUNTRY !== 'deny')
        ctx.addIssue({
          code: 'custom',
          path: ['GEO_UNKNOWN_COUNTRY'],
          message: 'must be "deny" in production',
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
  /**
   * Privy app id for email wallets (ADR-0035). Public by design (it is shipped
   * to browsers). Unset = only browser-extension wallets. Never the app secret.
   */
  /** Real-funds wording on the site (ADR-0038). Build-time; the API decides the network. */
  NEXT_PUBLIC_REAL_FUNDS: booleanString.default(false),
  NEXT_PUBLIC_PRIVY_APP_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, 'must be a Privy app id')
    .optional(),
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
