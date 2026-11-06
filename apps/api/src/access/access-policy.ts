/**
 * Pure access-policy rules (ADR-0022). Kept free of I/O so they can be
 * unit-tested exhaustively.
 */

export interface GeoConfig {
  GEO_COUNTRY_HEADER: string;
  GEO_REGION_HEADER: string;
  GEO_UNKNOWN_COUNTRY: 'allow' | 'deny';
  RESTRICTED_COUNTRIES: string[];
  /** ISO 3166-2 codes such as "CA-ON". */
  RESTRICTED_SUBDIVISIONS: string[];
}

/** Where a request comes from, as reported by the trusted edge. */
export interface Location {
  country: string | null;
  /** ISO 3166-2 code ("CA-ON"), or null when unknown. */
  subdivision: string | null;
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
 * The client's subdivision from the trusted edge header. Accepts the bare
 * subdivision part ("ON", as Cloudflare sends it) or the full code ("CA-ON").
 * A full code naming another country than `country` is treated as unknown.
 */
export function subdivisionFrom(
  headers: Record<string, string | string[] | undefined>,
  config: Pick<GeoConfig, 'GEO_REGION_HEADER'>,
  country: string | null,
): string | null {
  if (!config.GEO_REGION_HEADER || country === null) return null;
  const raw = headers[config.GEO_REGION_HEADER];
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase();
  const m = /^(?:([A-Z]{2})-)?([A-Z0-9]{1,3})$/.exec(v);
  if (!m || (m[1] !== undefined && m[1] !== country)) return null;
  return `${country}-${m[2]}`;
}

export function locationFrom(
  headers: Record<string, string | string[] | undefined>,
  config: Pick<GeoConfig, 'GEO_COUNTRY_HEADER' | 'GEO_REGION_HEADER'>,
): Location {
  const country = countryFrom(headers, config);
  return { country, subdivision: subdivisionFrom(headers, config, country) };
}

/**
 * Whether opening new risk is blocked for this location.
 * Region checks are off when no header is configured (local/ci only; the
 * config refuses that combination in production).
 *
 * A country with restricted subdivisions (Ontario in Canada, for example)
 * needs a known subdivision: when it is missing, the unknown-location policy
 * applies.
 */
export function regionRestricted(loc: Location, config: GeoConfig): boolean {
  if (!config.GEO_COUNTRY_HEADER) return false;
  const unknown = config.GEO_UNKNOWN_COUNTRY === 'deny';
  if (loc.country === null) return unknown;
  if (config.RESTRICTED_COUNTRIES.includes(loc.country)) return true;
  const prefix = `${loc.country}-`;
  const subs = config.RESTRICTED_SUBDIVISIONS.filter((s) => s.startsWith(prefix));
  if (subs.length === 0) return false;
  if (loc.subdivision === null) return unknown;
  return subs.includes(loc.subdivision);
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
