import fc from 'fast-check';
import { makerBps, splitTakerFee, takerBps, tierForVolume } from './fee-math';

describe('fee math (ADR-0018)', () => {
  it('applies discounts; taker never below zero, maker may become a rebate', () => {
    const p = { takerDiscountBps: 3, makerDiscountBps: 4, referrerId: null };
    expect(takerBps(5, p)).toBe(2);
    expect(takerBps(2, p)).toBe(0);
    expect(makerBps(2, p)).toBe(-2);
  });

  it('pays the rebate, then the referral share, and keeps the rest', () => {
    // Taker fee 50; maker rebate 2 bps of 100 000 = 20; referral 10% of 30 = 3.
    expect(splitTakerFee(50n, 100_000n, -2, 1000, true)).toEqual({
      rebate: 20n,
      referral: 3n,
      revenue: 27n,
    });
    // The rebate is capped at the taker fee.
    expect(splitTakerFee(5n, 100_000n, -2, 1000, true)).toEqual({
      rebate: 5n,
      referral: 0n,
      revenue: 0n,
    });
    expect(splitTakerFee(50n, 100_000n, 1, 1000, false)).toEqual({
      rebate: 0n,
      referral: 0n,
      revenue: 50n,
    });
  });

  it('never pays out more than the taker fee (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.bigInt({ min: 0n, max: 10n ** 20n }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.boolean(),
        (fee, basis, maker, share, ref) => {
          const s = splitTakerFee(fee, basis, maker, share, ref);
          expect(s.rebate + s.referral + s.revenue).toBe(fee);
          expect(s.rebate >= 0n && s.referral >= 0n && s.revenue >= 0n).toBe(true);
        },
      ),
    );
  });

  it('picks the highest tier reached', () => {
    const tiers = [
      { tier: 0, minVolume: 0n },
      { tier: 1, minVolume: 100n },
      { tier: 2, minVolume: 1000n },
    ];
    expect(tierForVolume(tiers, 0n)?.tier).toBe(0);
    expect(tierForVolume(tiers, 999n)?.tier).toBe(1);
    expect(tierForVolume(tiers, 1000n)?.tier).toBe(2);
  });
});
