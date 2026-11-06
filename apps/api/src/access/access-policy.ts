/**
 * Pure access-policy rules (ADR-0022). Kept free of I/O so they can be
 * unit-tested exhaustively.
 */

export interface GeoConfig {
  GEO_COUNTRY_HEADER: string;
  GEO_UNKNOWN_COUNTRY: 'allow' | 'deny';
  RESTRICTED_COUNTRIES: string[];
}

/** Codes some CDNs use for "unknown" or anonymising networks (e.g. Tor). Treated as unknown. */
const NOT_A_COUNTRY = new Set(['XX', 'T1', 'A1', 'A2', 'O1', 'EU', 'AP']);

/** The client's country from the trusted edge header, or null when unknown/disabled. */
export function countryFrom(
  headers: Record<string, string | string[] | undefined>,
  config: Pick<GeoConfig, 'GEO_COUNTRY_HEADER'>,
): string | null {
  if (!config.GEO_COUNTRY_HEADER) return null;
  const raw = headers[config.GEO_COUNTRY_HEADER];
  // A repeated header means something upstream did not overwrite it: unknown.
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || NOT_A_COUNTRY.has(code)) return null;
  return code;
}

/**
 * Whether opening new risk is blocked for this request's region.
 * Region checks are off when no header is configured (local/ci only; the
 * config refuses that combination in production).
 */
export function regionRestricted(country: string | null, config: GeoConfig): boolean {
  if (!config.GEO_COUNTRY_HEADER) return false;
  if (country === null) return config.GEO_UNKNOWN_COUNTRY === 'deny';
  return config.RESTRICTED_COUNTRIES.includes(country);
}

export type AccessKind = 'open' | 'manage' | 'withdraw';
export type ReduceOnlyShape = 'single' | 'batch';

/** Whether a request body only reduces positions (allowed from restricted regions). */
export function isReduceOnlyBody(shape: ReduceOnlyShape | undefined, body: unknown): boolean {
  if (!shape || typeof body !== 'object' || body === null) return false;
  if (shape === 'single') return (body as { reduceOnly?: unknown }).reduceOnly === true;
  const orders = (body as { orders?: unknown }).orders;
  return (
    Array.isArray(orders) &&
    orders.length > 0 &&
    orders.every(
      (o) =>
        typeof o === 'object' && o !== null && (o as { reduceOnly?: unknown }).reduceOnly === true,
    )
  );
}

export interface AccessFacts {
  regionRestricted: boolean;
  reduceOnly: boolean;
  sanctioned: boolean;
  termsAccepted: boolean;
}

export type AccessDecision =
  | { allow: true }
  | { allow: false; code: 'SANCTIONED_ADDRESS' | 'REGION_RESTRICTED' | 'TERMS_NOT_ACCEPTED' };

/**
 * The policy table:
 *
 * | kind     | sanctions | region (unless reduce-only) | terms |
 * | -------- | --------- | --------------------------- | ----- |
 * | open     | blocks    | blocks                      | needed |
 * | manage   | blocks    | —                           | needed |
 * | withdraw | blocks    | —                           | —      |
 *
 * Cancels are never gated: reducing exposure must always be possible.
 */
export function decide(kind: AccessKind, f: AccessFacts): AccessDecision {
  if (f.sanctioned) return { allow: false, code: 'SANCTIONED_ADDRESS' };
  if (kind === 'withdraw') return { allow: true };
  if (kind === 'open' && f.regionRestricted && !f.reduceOnly)
    return { allow: false, code: 'REGION_RESTRICTED' };
  if (!f.termsAccepted) return { allow: false, code: 'TERMS_NOT_ACCEPTED' };
  return { allow: true };
}

/** Lower-case 0x address, or null if the line is not one. */
export function normaliseAddress(line: string): string | null {
  const v = line.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(v) ? v : null;
}
