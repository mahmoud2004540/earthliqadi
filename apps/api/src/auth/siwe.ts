/**
 * Sign-In with Ethereum (EIP-4361) verification (ADR-0013). Pure functions:
 * message parsing, EIP-191 personal_sign hashing, secp256k1 public-key
 * recovery and EIP-55 checksums. Uses the audited @noble libraries.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

export interface SiweMessage {
  domain: string;
  /** EIP-55 or lower-case hex address as written in the message. */
  address: string;
  statement: string | null;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string | null;
}

const HEADER = / wants you to sign in with your Ethereum account:$/;

/** Parses an EIP-4361 message. Returns null if it is not well formed. */
export function parseSiweMessage(text: string): SiweMessage | null {
  if (text.length > 2048) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const header = lines[0] ?? '';
  if (!HEADER.test(header)) return null;
  const domain = header.replace(HEADER, '');
  const address = lines[1] ?? '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (lines[2] !== '') return null;
  let i = 3;
  let statement: string | null = null;
  if (lines[i] !== undefined && !lines[i]!.startsWith('URI: ')) {
    statement = lines[i]!;
    i++;
    if (lines[i] !== '') return null;
    i++;
  }
  const fields = new Map<string, string>();
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '') continue;
    const idx = line.indexOf(': ');
    if (idx <= 0) return null;
    const key = line.slice(0, idx);
    if (fields.has(key)) return null;
    fields.set(key, line.slice(idx + 2));
  }
  const uri = fields.get('URI');
  const version = fields.get('Version');
  const chainId = fields.get('Chain ID');
  const nonce = fields.get('Nonce');
  const issuedAt = fields.get('Issued At');
  if (!uri || version !== '1' || !chainId || !nonce || !issuedAt) return null;
  if (!/^[1-9]\d{0,15}$/.test(chainId) || !/^[A-Za-z0-9]{8,64}$/.test(nonce)) return null;
  if (Number.isNaN(Date.parse(issuedAt))) return null;
  const expirationTime = fields.get('Expiration Time') ?? null;
  if (expirationTime !== null && Number.isNaN(Date.parse(expirationTime))) return null;
  return {
    domain,
    address,
    statement,
    uri,
    version,
    chainId: Number(chainId),
    nonce,
    issuedAt,
    expirationTime,
  };
}

/** EIP-191 personal_sign digest. */
export function personalMessageHash(message: string): Uint8Array {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  return keccak_256(Buffer.concat([prefix, body]));
}

export function addressFromPublicKey(uncompressed: Uint8Array): string {
  return `0x${Buffer.from(keccak_256(uncompressed.slice(1)).slice(-20)).toString('hex')}`;
}

/** EIP-55 mixed-case checksum encoding. */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak_256(Buffer.from(lower, 'ascii'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i++)
    out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

/** Mixed-case addresses must carry a valid EIP-55 checksum. */
export function isValidAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/**
 * Recovers the signer address (lower case) of a 65-byte personal_sign
 * signature, or null if invalid. High-s signatures are rejected (malleability).
 */
export function recoverPersonalSigner(message: string, signatureHex: string): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) return null;
  const bytes = Buffer.from(signatureHex.slice(2), 'hex');
  let v = bytes[64]!;
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const sig = secp256k1.Signature.fromCompact(bytes.subarray(0, 64)).addRecoveryBit(v);
    if (sig.hasHighS()) return null;
    const point = sig.recoverPublicKey(personalMessageHash(message));
    return addressFromPublicKey(point.toRawBytes(false));
  } catch {
    return null;
  }
}

export interface SiweExpectations {
  /** Host (and port) of the web origin, e.g. "localhost:3000". */
  domain: string;
  /** Web origin the URI must belong to. */
  origin: string;
  now: Date;
  /** Maximum age of Issued At. */
  maxAgeMs: number;
}

export type SiweFailure =
  | 'malformed'
  | 'bad_address'
  | 'wrong_domain'
  | 'wrong_uri'
  | 'stale'
  | 'expired'
  | 'bad_signature';

/** Validates message fields and signature. The caller still checks the nonce. */
export function verifySiwe(
  text: string,
  signature: string,
  exp: SiweExpectations,
): { ok: true; message: SiweMessage; address: string } | { ok: false; reason: SiweFailure } {
  const message = parseSiweMessage(text);
  if (!message) return { ok: false, reason: 'malformed' };
  if (!isValidAddress(message.address)) return { ok: false, reason: 'bad_address' };
  if (message.domain !== exp.domain) return { ok: false, reason: 'wrong_domain' };
  let uriOrigin: string;
  try {
    uriOrigin = new URL(message.uri).origin;
  } catch {
    return { ok: false, reason: 'wrong_uri' };
  }
  if (uriOrigin !== exp.origin) return { ok: false, reason: 'wrong_uri' };
  const issued = Date.parse(message.issuedAt);
  const now = exp.now.getTime();
  if (issued > now + 60_000 || now - issued > exp.maxAgeMs) return { ok: false, reason: 'stale' };
  if (message.expirationTime !== null && Date.parse(message.expirationTime) <= now)
    return { ok: false, reason: 'expired' };
  const signer = recoverPersonalSigner(text, signature);
  if (!signer || signer !== message.address.toLowerCase())
    return { ok: false, reason: 'bad_signature' };
  return { ok: true, message, address: signer };
}
