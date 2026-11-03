import { base32Decode, base32Encode, hotp, timeStep, totpUri, verifyTotp } from './totp';

// RFC 6238 Appendix B test vectors (SHA-1).
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(VECTORS)('matches the RFC vector at T=%i', (seconds, expected) => {
    expect(hotp(RFC_SECRET, timeStep(seconds * 1000), 8)).toBe(expected);
  });

  it('verifies a 6-digit code and returns its time-step', () => {
    const nowMs = 1111111111 * 1000;
    const step = verifyTotp(RFC_SECRET, '050471', { nowMs });
    expect(step).toBe(timeStep(nowMs));
  });

  it('accepts adjacent steps within the window but not beyond', () => {
    const nowMs = 1234567890 * 1000;
    const prev = hotp(RFC_SECRET, timeStep(nowMs) - 1);
    const old = hotp(RFC_SECRET, timeStep(nowMs) - 3);
    expect(verifyTotp(RFC_SECRET, prev, { nowMs })).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, old, { nowMs })).toBeNull();
  });

  it('rejects replay of an already-used time-step', () => {
    const nowMs = 1234567890 * 1000;
    const code = hotp(RFC_SECRET, timeStep(nowMs));
    const step = verifyTotp(RFC_SECRET, code, { nowMs });
    expect(step).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, code, { nowMs, lastUsedStep: step })).toBeNull();
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp(RFC_SECRET, '12345')).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef')).toBeNull();
  });

  it('encodes base32 per RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('round-trips base32', () => {
    expect(base32Decode(base32Encode(RFC_SECRET)).equals(RFC_SECRET)).toBe(true);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('builds an otpauth URI with issuer and account', () => {
    const uri = totpUri({ secret: RFC_SECRET, issuer: 'Exchange', account: 'a@b.co' });
    expect(uri.startsWith('otpauth://totp/Exchange%3Aa%40b.co?')).toBe(true);
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri).toContain('issuer=Exchange');
  });
});
