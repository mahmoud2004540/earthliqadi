import { createHmac, randomBytes } from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s step) — the parameters supported by
 * all mainstream authenticator apps. Implemented locally (≈60 lines, tested
 * against the RFC test vectors) to avoid an extra dependency.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20); // 160 bits, as recommended by RFC 4226
}

export function timeStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Verify a code within ±`window` steps. Returns the matched step (for replay
 * protection) or null. Steps at or below `lastUsedStep` are rejected.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  options: { nowMs?: number; window?: number; lastUsedStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = timeStep(options.nowMs);
  const window = options.window ?? 1;
  let matched: number | null = null;
  // Check every candidate (no early exit) to keep timing independent of position.
  for (let step = current - window; step <= current + window; step++) {
    if (hotp(secret, step) === code && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (options.lastUsedStep != null && matched <= options.lastUsedStep) return null;
  return matched;
}

export function totpUri(params: { secret: Buffer; issuer: string; account: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
