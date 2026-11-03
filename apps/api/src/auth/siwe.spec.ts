import { secp256k1 } from '@noble/curves/secp256k1';
import {
  addressFromPublicKey,
  isValidAddress,
  parseSiweMessage,
  personalMessageHash,
  recoverPersonalSigner,
  toChecksumAddress,
  verifySiwe,
} from './siwe';

// Well-known test key (web3.js documentation). Never use for real funds.
const PRIVATE_KEY = Buffer.from(
  '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
  'hex',
);
const ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

function sign(message: string, key = PRIVATE_KEY): string {
  const sig = secp256k1.sign(personalMessageHash(message), key);
  return `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}${(27 + sig.recovery).toString(16)}`;
}

function message(overrides: Partial<Record<string, string>> = {}, address = ADDRESS): string {
  const f = {
    domain: 'localhost:3000',
    uri: 'http://localhost:3000',
    nonce: 'abcdef0123456789',
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
  return [
    `${f.domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to the exchange (paper trading).',
    '',
    `URI: ${f.uri}`,
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
  ].join('\n');
}

const exp = () => ({
  domain: 'localhost:3000',
  origin: 'http://localhost:3000',
  now: new Date(),
  maxAgeMs: 5 * 60_000,
});

describe('SIWE (EIP-4361) verification', () => {
  it('derives the known address and EIP-55 checksum', () => {
    const pub = secp256k1.getPublicKey(PRIVATE_KEY, false);
    expect(addressFromPublicKey(pub)).toBe(ADDRESS.toLowerCase());
    expect(toChecksumAddress(ADDRESS.toLowerCase())).toBe(ADDRESS);
    expect(isValidAddress(ADDRESS)).toBe(true);
    expect(isValidAddress(ADDRESS.toLowerCase())).toBe(true);
    expect(isValidAddress(ADDRESS.replace('E', 'e'))).toBe(false); // broken checksum
  });

  it('parses messages with and without a statement', () => {
    expect(parseSiweMessage(message())).toMatchObject({
      domain: 'localhost:3000',
      address: ADDRESS,
      chainId: 1,
      nonce: 'abcdef0123456789',
      statement: 'Sign in to the exchange (paper trading).',
    });
    const noStatement = message().replace('Sign in to the exchange (paper trading).\n\n', '');
    expect(parseSiweMessage(noStatement)?.statement).toBeNull();
    expect(parseSiweMessage('hello')).toBeNull();
    expect(parseSiweMessage(message().replace('Version: 1', 'Version: 2'))).toBeNull();
  });

  it('recovers the signer and accepts a valid sign-in', () => {
    const m = message();
    const s = sign(m);
    expect(recoverPersonalSigner(m, s)).toBe(ADDRESS.toLowerCase());
    expect(verifySiwe(m, s, exp())).toMatchObject({ ok: true, address: ADDRESS.toLowerCase() });
  });

  it('rejects wrong domain, foreign URI, stale or expired messages, and forged signatures', () => {
    const other = secp256k1.utils.randomPrivateKey();
    const cases: [string, string, string][] = [
      [message({ domain: 'evil.example' }), '', 'wrong_domain'],
      [message({ uri: 'https://evil.example/login' }), '', 'wrong_uri'],
      [message({ issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() }), '', 'stale'],
      [
        `${message()}\nExpiration Time: ${new Date(Date.now() - 1000).toISOString()}`,
        '',
        'expired',
      ],
    ];
    for (const [m, , reason] of cases)
      expect(verifySiwe(m, sign(m), exp())).toEqual({ ok: false, reason });
    const m = message();
    expect(verifySiwe(m, sign(m, Buffer.from(other)), exp())).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifySiwe(m, '0x1234', exp())).toEqual({ ok: false, reason: 'bad_signature' });
    // A signature over a different message does not verify this one.
    expect(verifySiwe(m, sign(`${m} `), exp())).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
