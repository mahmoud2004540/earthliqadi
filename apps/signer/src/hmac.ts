import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request authentication between the API and the signer: HMAC-SHA256 over
 * `${timestamp}.${requestId}.${body}`. The signer rejects stale timestamps and
 * reused request ids, so captured requests cannot be replayed.
 */
export function signRequest(
  secret: string,
  timestamp: string,
  requestId: string,
  body: string,
): string {
  return createHmac('sha256', secret).update(`${timestamp}.${requestId}.${body}`).digest('hex');
}

export function verifyRequest(
  secret: string,
  headers: { timestamp?: string; requestId?: string; signature?: string },
  body: string,
  now: Date,
  maxSkewMs = 30_000,
): 'ok' | 'missing' | 'stale' | 'bad_signature' {
  const { timestamp, requestId, signature } = headers;
  if (!timestamp || !requestId || !signature) return 'missing';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() - ts) > maxSkewMs) return 'stale';
  const expected = Buffer.from(signRequest(secret, timestamp, requestId, body), 'hex');
  const given = Buffer.from(signature, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'bad_signature';
  return 'ok';
}
