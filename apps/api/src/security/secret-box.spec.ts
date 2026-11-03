import { randomBytes } from 'node:crypto';
import { SecretBox } from './secret-box';

describe('SecretBox (AES-256-GCM)', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));
  const secret = Buffer.from('totp-seed-bytes');

  it('round-trips with the same AAD', () => {
    expect(box.open(box.seal(secret, 'totp:user-1'), 'totp:user-1').equals(secret)).toBe(true);
  });

  it('uses a fresh IV per seal', () => {
    expect(Buffer.from(box.seal(secret, 'a')).equals(Buffer.from(box.seal(secret, 'a')))).toBe(
      false,
    );
  });

  it('fails when the ciphertext is moved to another owner (AAD mismatch)', () => {
    expect(() => box.open(box.seal(secret, 'totp:user-1'), 'totp:user-2')).toThrow();
  });

  it('fails on tampering', () => {
    const sealed = box.seal(secret, 'x');
    const last = sealed.length - 1;
    sealed[last] = (sealed[last] ?? 0) ^ 0xff;
    expect(() => box.open(sealed, 'x')).toThrow();
  });

  it('fails with a different key', () => {
    const other = new SecretBox(randomBytes(32).toString('base64'));
    expect(() => other.open(box.seal(secret, 'x'), 'x')).toThrow();
  });

  it('rejects keys of the wrong size', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow();
  });
});
