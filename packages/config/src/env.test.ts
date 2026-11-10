import { describe, expect, it } from 'vitest';
import { apiEnvSchema, EnvValidationError, parseEnv, webEnvSchema } from './env';

const validKey = Buffer.alloc(32, 7).toString('base64');

const localEnv = {
  DATABASE_URL: 'postgresql://app:pw@localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379',
  WEB_ORIGIN: 'http://localhost:3000',
  CSRF_SECRET: 'a'.repeat(40),
  MFA_ENCRYPTION_KEY: validKey,
  SESSION_COOKIE_SECURE: 'false',
};

const productionEnv = {
  ...localEnv,
  NODE_ENV: 'production',
  DEPLOY_ENV: 'production',
  WEB_ORIGIN: 'https://exchange.invalid',
  SESSION_COOKIE_SECURE: 'true',
};

describe('apiEnvSchema', () => {
  it('accepts a valid local configuration and applies defaults', () => {
    const env = parseEnv(apiEnvSchema, localEnv);
    expect(env.API_PORT).toBe(4000);
    expect(env.SESSION_COOKIE_SECURE).toBe(false);
    expect(env.ARGON2_MEMORY_KIB).toBeGreaterThanOrEqual(19456);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('rejects missing required variables and lists them without values', () => {
    try {
      parseEnv(apiEnvSchema, { CSRF_SECRET: 'super-secret-value-that-must-not-leak-0000' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('MFA_ENCRYPTION_KEY');
      expect(message).not.toContain('super-secret-value');
    }
  });

  it('rejects an MFA key of the wrong length', () => {
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...localEnv,
        MFA_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
      }),
    ).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it('rejects argon2 parameters below the OWASP minimum', () => {
    expect(() => parseEnv(apiEnvSchema, { ...localEnv, ARGON2_MEMORY_KIB: '1024' })).toThrow(
      /ARGON2_MEMORY_KIB/,
    );
  });

  it('refuses development-only settings in production', () => {
    expect(() => parseEnv(apiEnvSchema, { ...productionEnv, MAIL_TRANSPORT: 'log' })).toThrow(
      /MAIL_TRANSPORT/,
    );
    expect(() =>
      parseEnv(apiEnvSchema, { ...productionEnv, SESSION_COOKIE_SECURE: 'false' }),
    ).toThrow(/SESSION_COOKIE_SECURE/);
    expect(() =>
      parseEnv(apiEnvSchema, { ...productionEnv, WEB_ORIGIN: 'http://insecure.invalid' }),
    ).toThrow(/WEB_ORIGIN/);
  });

  it('refuses placeholder secrets in production', () => {
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...productionEnv,
        CSRF_SECRET: 'change-me-change-me-change-me-change-me',
      }),
    ).toThrow(/CSRF_SECRET/);
  });

  it('refuses a degenerate MFA key (such as the all-zero example) in production', () => {
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...productionEnv,
        MFA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      }),
    ).toThrow(/MFA_ENCRYPTION_KEY: looks degenerate/);
  });

  it('requires enforceable region restrictions in production (ADR-0022)', () => {
    // The counsel-approved list is the default (ADR-0024); it needs the edge headers.
    expect(() => parseEnv(apiEnvSchema, productionEnv)).toThrow(/GEO_COUNTRY_HEADER/);
    expect(() => parseEnv(apiEnvSchema, productionEnv)).toThrow(/GEO_REGION_HEADER/);
    expect(() => parseEnv(apiEnvSchema, { ...productionEnv, RESTRICTED_COUNTRIES: 'US' })).toThrow(
      /GEO_COUNTRY_HEADER/,
    );
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...productionEnv,
        RESTRICTED_COUNTRIES: 'US',
        GEO_COUNTRY_HEADER: 'cf-ipcountry',
      }),
    ).toThrow(/GEO_UNKNOWN_COUNTRY/);
    const geo = {
      ...productionEnv,
      RESTRICTED_COUNTRIES: 'US',
      GEO_COUNTRY_HEADER: 'x-edge-country',
      GEO_UNKNOWN_COUNTRY: 'deny',
    };
    expect(() => parseEnv(apiEnvSchema, geo)).toThrow(/SANCTIONS_SYNC_HOURS/);
    expect(() =>
      parseEnv(apiEnvSchema, {
        ...geo,
        SANCTIONS_SYNC_HOURS: '24',
        RESTRICTED_SUBDIVISIONS: 'CA-ON',
      }),
    ).toThrow(/GEO_REGION_HEADER/);
    expect(() =>
      parseEnv(apiEnvSchema, { ...localEnv, RESTRICTED_SUBDIVISIONS: 'Ontario' }),
    ).toThrow(/RESTRICTED_SUBDIVISIONS/);
    expect(() =>
      parseEnv(apiEnvSchema, { ...localEnv, SANCTIONS_OFAC_URL: 'http://plain.invalid/sdn.csv' }),
    ).toThrow(/SANCTIONS_OFAC_URL/);
    const local = parseEnv(apiEnvSchema, localEnv);
    expect(local.RESTRICTED_COUNTRIES).toEqual(['US', 'CU', 'IR', 'KP']);
    expect(local.RESTRICTED_SUBDIVISIONS).toEqual(['CA-ON', 'UA-43', 'UA-40', 'UA-14', 'UA-09']);
    expect(local.GEO_RESTRICTED_MODE).toBe('block_all');
    expect(local.SANCTIONS_SYNC_HOURS).toBe(0);
    expect(local.GEO_COUNTRY_HEADER).toBe('');
    expect(local.TERMS_VERSION).toBe('draft-2');
  });

  it('needs the signer and a reorg-safe confirmation depth for a public chain (ADR-0034)', () => {
    const chain = { ...productionEnv, CHAIN_RPC_URL: 'https://rpc.invalid' };
    expect(() => parseEnv(apiEnvSchema, chain)).toThrow(/SIGNER_URL/);
    expect(() => parseEnv(apiEnvSchema, chain)).toThrow(/CHAIN_CONFIRMATIONS: must be at least 5/);
    expect(() => parseEnv(apiEnvSchema, { ...chain, CHAIN_CONFIRMATIONS: '12' })).not.toThrow(
      /CHAIN_CONFIRMATIONS/,
    );
    // Local chains may confirm immediately.
    expect(
      parseEnv(apiEnvSchema, {
        ...localEnv,
        CHAIN_RPC_URL: 'http://localhost:8545',
        CHAIN_CONFIRMATIONS: '0',
      }).CHAIN_CONFIRMATIONS,
    ).toBe(0);
  });

  it('treats empty strings as unset', () => {
    const env = parseEnv(apiEnvSchema, { ...localEnv, API_PORT: '' });
    expect(env.API_PORT).toBe(4000);
  });
});

describe('webEnvSchema', () => {
  it('provides a neutral brand default', () => {
    expect(parseEnv(webEnvSchema, {}).NEXT_PUBLIC_BRAND_NAME).toBe('Exchange');
  });

  it('accepts a Privy app id, and refuses anything that is not one', () => {
    expect(parseEnv(webEnvSchema, {}).NEXT_PUBLIC_PRIVY_APP_ID).toBeUndefined();
    expect(
      parseEnv(webEnvSchema, { NEXT_PUBLIC_PRIVY_APP_ID: 'cm1abcdefgh0123456789xyz' })
        .NEXT_PUBLIC_PRIVY_APP_ID,
    ).toBe('cm1abcdefgh0123456789xyz');
    expect(() =>
      parseEnv(webEnvSchema, { NEXT_PUBLIC_PRIVY_APP_ID: 'https://x.example/?a=b' }),
    ).toThrow(EnvValidationError);
  });
});
