import { generateKeyPairSync, sign } from 'node:crypto';
import { authorizationMessage, canonicalRequest, ipAllowed, verifyEd25519 } from './api-key-auth';

describe('agent API key helpers', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const msg = canonicalRequest('1700000000000', 'post', '/v1/orders?x=1', '{"a":1}');

  it('builds the canonical request string', () => {
    expect(msg).toBe('1700000000000\nPOST\n/v1/orders?x=1\n{"a":1}');
  });

  it('verifies Ed25519 signatures and rejects tampering or garbage', () => {
    const sig = sign(null, Buffer.from(msg), privateKey).toString('base64');
    expect(verifyEd25519(hex, msg, sig)).toBe(true);
    expect(verifyEd25519(hex, `${msg} `, sig)).toBe(false);
    expect(verifyEd25519(hex, msg, 'AAAA')).toBe(false);
    expect(verifyEd25519('zz', msg, sig)).toBe(false);
  });

  it('checks IP allow-lists (empty = any)', () => {
    expect(ipAllowed([], '1.2.3.4')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], '203.0.113.9')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], '::ffff:203.0.113.9')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], '198.51.100.1')).toBe(false);
    expect(ipAllowed(['198.51.100.7'], '198.51.100.7')).toBe(true);
    expect(ipAllowed(['2001:db8::/32'], '2001:db8::1')).toBe(true);
    expect(ipAllowed(['203.0.113.0/24'], undefined)).toBe(false);
  });

  it('states scopes, expiry and the no-withdrawal rule in the signed text', () => {
    const text = authorizationMessage({
      domain: 'example.test',
      address: '0xabc',
      publicKey: hex,
      label: 'bot',
      scopes: ['trade', 'read'],
      allowedIps: [],
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      nonce: 'n1',
    });
    expect(text).toContain('Scopes: read, trade');
    expect(text).toContain('IP allow-list: any');
    expect(text).toContain('Expires: 2027-01-01T00:00:00.000Z');
    expect(text).toContain('It can never withdraw funds.');
  });
});
