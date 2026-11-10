import { describe, expect, it } from 'vitest';
import { en } from './en';
import { REAL_FUNDS_REPLACEMENTS, withRealFunds } from './real-funds';

const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];

describe('real-funds wording (ADR-0038)', () => {
  it('replaces sentences that exist, so the two never drift apart', () => {
    const all = new Set(strings(en));
    for (const [from] of REAL_FUNDS_REPLACEMENTS) expect(all.has(from)).toBe(true);
  });

  it('leaves no testnet or "no real funds" statement behind', () => {
    const text = strings(withRealFunds(en)).join('\n').toLowerCase();
    for (const phrase of [
      'no real funds',
      'pre-launch',
      'test chain only',
      'testnet beta',
      'must not be used with real funds',
      'no customer funds',
    ]) {
      expect(text).not.toContain(phrase);
    }
  });

  it('never claims an audit, a licence, insurance or a partnership', () => {
    const text = strings(withRealFunds(en)).join('\n').toLowerCase();
    for (const claim of [
      'we are licensed',
      'fully licensed',
      'insured',
      'audited by',
      'partnered with',
      'guaranteed',
    ]) {
      expect(text).not.toContain(claim);
    }
    expect(text).toContain('not been independently audited');
  });
});
