import fc from 'fast-check';
import type { MarketUnits } from '../trading/order-math';
import { initialMargin, notionalAt, unrealizedPnl } from './perp-math';
import { simulate, type SimInput } from './risk-sim';

// tick 0.01, lot 0.0001 → notionals at whole-tick prices are exact integers.
const U: MarketUnits = { baseScale: 8, quoteScale: 6, tickSize: 10_000n, lotSize: 10_000n };
const USD = 1_000_000n;
const price = (p: number): bigint => BigInt(Math.round(p * 100)) * 10_000n;

function totalValue(input: SimInput, r: ReturnType<typeof simulate>): bigint {
  const last = input.path.length ? input.path[input.path.length - 1]! : input.entryPrice;
  let v = r.insuranceFund + r.lp.cash + unrealizedPnl(r.lp, last, U);
  for (const c of r.cash.values()) v += c;
  for (const p of r.open.values()) v += p.margin + unrealizedPnl(p, last, U);
  return v;
}

function initialValue(input: SimInput): bigint {
  return input.traders.reduce(
    (a, t) => a + initialMargin(notionalAt(input.entryPrice, t.size, U), t.leverage),
    input.insuranceFund,
  );
}

describe('risk simulation harness (synthetic price paths)', () => {
  const base: Omit<SimInput, 'path'> = {
    units: U,
    entryPrice: price(100),
    traders: [
      { id: 'long-10x', size: 10_000n, leverage: 10 },
      { id: 'long-2x', size: 10_000n, leverage: 2 },
      { id: 'short-20x', size: -10_000n, leverage: 20 },
    ],
    mmrBps: 250,
    liquidationFeeBps: 50,
    insuranceFund: 100n * USD,
  };

  it('liquidates in order of leverage on a crash and keeps every liquidated trader at ≥ 0', () => {
    const input = { ...base, path: [price(97), price(92), price(80), price(60), price(49)] };
    const r = simulate(input);
    expect([...r.cash.keys()]).toEqual(['long-10x', 'long-2x']);
    expect(r.open.has('short-20x')).toBe(true);
    for (const c of r.cash.values()) expect(c >= 0n).toBe(true);
    expect(r.adlDeficit).toBe(0n);
    expect(totalValue(input, r)).toBe(initialValue(input));
  });

  it('a gap through the bankruptcy price is paid by the insurance fund, then by ADL', () => {
    const gap = { ...base, path: [price(70)], insuranceFund: 0n };
    const r = simulate(gap);
    // long-10x (margin 10) loses 30 at 70: deficit 20, fund empty → ADL on the profitable short.
    expect(r.adlEvents.length).toBeGreaterThan(0);
    expect(r.adlEvents[0]!.id).toBe('short-20x');
    expect(r.adlDeficit).toBe(20n * USD);
    expect(totalValue(gap, r)).toBe(initialValue(gap));

    const funded = { ...gap, insuranceFund: 1_000n * USD };
    const f = simulate(funded);
    expect(f.adlDeficit).toBe(0n);
    expect(f.insuranceFund).toBe(980n * USD);
    expect(totalValue(funded, f)).toBe(initialValue(funded));
  });

  it('property: value is conserved and nobody goes below zero on random paths', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            size: fc.integer({ min: -50_000, max: 50_000 }).filter((s) => s !== 0),
            leverage: fc.integer({ min: 1, max: 20 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.array(fc.integer({ min: 100, max: 50_000 }), { maxLength: 40 }), // cents
        fc.integer({ min: 0, max: 1_000 }),
        (traders, cents, fund) => {
          const input: SimInput = {
            ...base,
            traders: traders.map((t, i) => ({
              id: `t${i}`,
              size: BigInt(t.size),
              leverage: t.leverage,
            })),
            path: cents.map((c) => BigInt(c) * 10_000n),
            insuranceFund: BigInt(fund) * USD,
          };
          const r = simulate(input);
          expect(totalValue(input, r)).toBe(initialValue(input));
          expect(r.insuranceFund >= 0n).toBe(true);
          for (const c of r.cash.values()) expect(c >= 0n).toBe(true);
          for (const p of r.open.values()) expect(p.margin >= 0n).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
