import fc from 'fast-check';
import { AppError } from '../common/app-error';
import {
  assertBalancedPerAsset,
  balanceDelta,
  fingerprintOf,
  mirrorPostings,
  toMinorUnits,
  validateEntryRequest,
  type EntryRequest,
} from './ledger-domain';

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';

const base: EntryRequest = {
  type: 'BALANCE_HOLD',
  idempotencyKey: 'hold:order-123',
  description: 'test',
  postings: [
    { accountId: B, direction: 'CREDIT', amount: 5n },
    { accountId: A, direction: 'DEBIT', amount: 5n },
  ],
};

describe('validateEntryRequest', () => {
  it('sorts postings by account id (deterministic lock order)', () => {
    expect(validateEntryRequest(base).map((p) => p.accountId)).toEqual([A, B]);
  });

  it.each([
    ['fewer than two postings', { postings: [base.postings[0]!] }],
    ['zero amount', { postings: [{ ...base.postings[0]!, amount: 0n }, base.postings[1]!] }],
    ['negative amount', { postings: [{ ...base.postings[0]!, amount: -1n }, base.postings[1]!] }],
    [
      'duplicate account',
      { postings: [base.postings[0]!, { ...base.postings[0]!, direction: 'DEBIT' as const }] },
    ],
    ['short idempotency key', { idempotencyKey: 'short' }],
    ['bad idempotency key characters', { idempotencyKey: 'has spaces in it' }],
    ['empty description', { description: '' }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateEntryRequest({ ...base, ...patch })).toThrow(AppError);
  });

  it('rejects non-bigint amounts (no floating point)', () => {
    const bad = {
      ...base,
      postings: [{ ...base.postings[0]!, amount: 1.5 as unknown as bigint }, base.postings[1]!],
    };
    expect(() => validateEntryRequest(bad)).toThrow(AppError);
  });
});

describe('assertBalancedPerAsset', () => {
  it('accepts balanced multi-asset entries', () => {
    expect(() =>
      assertBalancedPerAsset([
        { assetId: 'btc', direction: 'DEBIT', amount: 1n },
        { assetId: 'btc', direction: 'CREDIT', amount: 1n },
        { assetId: 'usdt', direction: 'DEBIT', amount: 30000n },
        { assetId: 'usdt', direction: 'CREDIT', amount: 30000n },
      ]),
    ).not.toThrow();
  });

  it('rejects entries balanced overall but not per asset', () => {
    expect(() =>
      assertBalancedPerAsset([
        { assetId: 'btc', direction: 'DEBIT', amount: 5n },
        { assetId: 'usdt', direction: 'CREDIT', amount: 5n },
      ]),
    ).toThrow(/not balanced/);
  });
});

describe('balanceDelta', () => {
  it('increases on the normal side and decreases on the other', () => {
    expect(balanceDelta('CREDIT', 'CREDIT', 7n)).toBe(7n);
    expect(balanceDelta('CREDIT', 'DEBIT', 7n)).toBe(-7n);
    expect(balanceDelta('DEBIT', 'DEBIT', 7n)).toBe(7n);
  });
});

describe('fingerprintOf', () => {
  it('is independent of posting order', () => {
    expect(fingerprintOf(base)).toBe(
      fingerprintOf({ ...base, postings: [...base.postings].reverse() }),
    );
  });

  it('changes when the amount, direction or type changes', () => {
    const fp = fingerprintOf(base);
    expect(fingerprintOf({ ...base, type: 'BALANCE_RELEASE' })).not.toBe(fp);
    expect(fingerprintOf({ ...base, postings: mirrorPostings(base.postings) })).not.toBe(fp);
    expect(
      fingerprintOf({ ...base, postings: base.postings.map((p) => ({ ...p, amount: 6n })) }),
    ).not.toBe(fp);
  });

  it('ignores the description (metadata, not money)', () => {
    expect(fingerprintOf({ ...base, description: 'other' })).toBe(fingerprintOf(base));
  });
});

describe('toMinorUnits', () => {
  it('converts NUMERIC text and decimal-like objects exactly', () => {
    expect(toMinorUnits('99999999999999999999999999999999999999')).toBe(10n ** 38n - 1n);
    expect(toMinorUnits({ toFixed: () => '-42' })).toBe(-42n);
    expect(() => toMinorUnits('1.5')).toThrow();
  });
});

describe('ledger properties', () => {
  // Model: random balanced entries over a small chart of accounts. The sum of all
  // signed balances (debit-normal positive, credit-normal negative) stays zero, and
  // a mirror entry restores every balance exactly.
  const accounts = [
    { id: 'a1', normal: 'DEBIT' as const },
    { id: 'a2', normal: 'CREDIT' as const },
    { id: 'a3', normal: 'CREDIT' as const },
    { id: 'a4', normal: 'DEBIT' as const },
  ];
  const entryArb = fc
    .tuple(
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 3 }),
      fc.bigInt({ min: 1n, max: 10n ** 30n }),
    )
    .filter(([d, c]) => d !== c)
    .map(([d, c, amount]) => [
      { accountId: accounts[d]!.id, direction: 'DEBIT' as const, amount },
      { accountId: accounts[c]!.id, direction: 'CREDIT' as const, amount },
    ]);

  function apply(
    balances: Map<string, bigint>,
    postings: { accountId: string; direction: 'DEBIT' | 'CREDIT'; amount: bigint }[],
  ) {
    for (const p of postings) {
      const acc = accounts.find((a) => a.id === p.accountId)!;
      balances.set(
        p.accountId,
        (balances.get(p.accountId) ?? 0n) + balanceDelta(acc.normal, p.direction, p.amount),
      );
    }
  }

  it('trial balance stays zero and mirrors undo exactly', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { minLength: 1, maxLength: 50 }), (entries) => {
        const balances = new Map<string, bigint>();
        for (const e of entries) apply(balances, e);
        const trial = accounts.reduce((sum, a) => {
          const b = balances.get(a.id) ?? 0n;
          return sum + (a.normal === 'DEBIT' ? b : -b);
        }, 0n);
        if (trial !== 0n) return false;
        for (const e of [...entries].reverse()) apply(balances, mirrorPostings(e));
        return accounts.every((a) => (balances.get(a.id) ?? 0n) === 0n);
      }),
    );
  });
});
