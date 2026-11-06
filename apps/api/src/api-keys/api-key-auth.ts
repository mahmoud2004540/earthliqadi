import { createPublicKey, verify } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

/**
 * Pure helpers for agent API keys (ADR-0017). Requests are signed with the
 * key's Ed25519 private key; the server only ever holds the public key.
 *
 * Canonical request string (UTF-8):
 *   `${timestampMs}\n${METHOD}\n${pathWithQuery}\n${body}`
 */
export function canonicalRequest(
  timestampMs: string,
  method: string,
  pathWithQuery: string,
  body: string,
): string {
  return `${timestampMs}\n${method.toUpperCase()}\n${pathWithQuery}\n${body}`;
}

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(
  publicKeyHex: string,
  message: string,
  signatureB64: string,
): boolean {
  try {
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

/** Accepts an address when the list is empty or one entry (IP or CIDR) contains it. */
export function ipAllowed(allowed: readonly string[], ip: string | undefined): boolean {
  if (allowed.length === 0) return true;
  if (!ip) return false;
  const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const family = isIP(plain) === 6 ? 'ipv6' : 'ipv4';
  const list = new BlockList();
  for (const entry of allowed) {
    const [addr, bits] = entry.split('/');
    const fam = isIP(addr ?? '') === 6 ? 'ipv6' : 'ipv4';
    if (isIP(addr ?? '') === 0) continue;
    list.addSubnet(addr!, Number(bits ?? (fam === 'ipv6' ? 128 : 32)), fam);
  }
  return list.check(plain, family);
}

/** The exact text the wallet signs to authorise a key. Rebuilt server-side, never trusted from the client. */
export function authorizationMessage(input: {
  domain: string;
  address: string;
  publicKey: string;
  label: string;
  scopes: readonly string[];
  allowedIps: readonly string[];
  expiresAt: Date;
  nonce: string;
}): string {
  return [
    `${input.domain} wants you to authorize an API key for ${input.address}.`,
    '',
    `Key: ${input.publicKey}`,
    `Label: ${input.label}`,
    `Scopes: ${[...input.scopes].sort().join(', ')}`,
    `IP allow-list: ${input.allowedIps.length ? input.allowedIps.join(', ') : 'any'}`,
    `Expires: ${input.expiresAt.toISOString()}`,
    `Nonce: ${input.nonce}`,
    '',
    'This key can only read your account and place or cancel orders. It can never withdraw funds.',
  ].join('\n');
}
