import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM authenticated encryption for small secrets at rest (e.g. TOTP seeds).
 * Layout: iv(12) | tag(16) | ciphertext. `aad` binds the ciphertext to its owner
 * so a ciphertext copied to another row fails to decrypt.
 *
 * Production note: the key comes from the environment today. It must move to a
 * KMS/HSM-backed secret manager before any production deployment.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    this.key = key;
  }

  seal(plaintext: Buffer, aad: string): Uint8Array<ArrayBuffer> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    // Copy into a plain ArrayBuffer-backed array (what Prisma's Bytes type expects).
    return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
  }

  open(sealed: Buffer | Uint8Array, aad: string): Buffer {
    const buf = Buffer.from(sealed);
    if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('Sealed value too short');
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
