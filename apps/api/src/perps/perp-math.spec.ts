import fc from 'fast-check';
import { quoteAmount, type MarketUnits } from '../trading/order-math';
import {
  adlRanking,
  allocateFunding,
  applyFill,
  bankruptcyTicks,
  computeIndex,
  emaStep,
  equity,
  fundingRate,
  initialMargin,
  isLiquidatable,
  markPrice,
  medianBig,
  notionalAt,
  premiumRate,
  RATE_SCALE,
  tierFor,
  validateTiers,
  withinBankruptcy,
  type PositionState,
} from './perp-math';

// BTC (8) / USDT (6): tick 0.01, lot 0.0001 → notional = ticks × lots exactly.
const U: MarketUnits = { baseScale: 8, quoteScale: 6, tickSize: 10_000n, lotSize: 10_000n };
const USD = 1_000_000n;
const ONE_BTC = 10_000n; // lots
const ticks = (price: number): bigint => BigInt(Math.round(price * 100));
const notional = (t: bigint, lots: bigint): bigint => quoteAmount(t, lots, U);
const FLAT: PositionState = { size: 0n, entry: 0n, margin: 0n };

describe('applyFill', () => {
  it('opens, adds, partially closes with profit and fully closes', () => {
    const n1 = notional(ticks(100), ONE_BTC); // 100 USDT
    let r = applyFill(FLAT, ONE_BTC, n1);
    expect(r.next).toEqual({ size: ONE_BTC, entry: 100n * USD, margin: 0n });
    expect(r.openedLots).toBe(ONE_BTC);

    r = applyFill({ ...r.next, margin: 20n * USD }, ONE_BTC, notional(ticks(120), ONE_BTC));
    expect(r.next).toEqual({ size: 2n * ONE_BTC, entry: 220n * USD, margin: 20n * USD });

    // Sell 1 BTC at 130: closes half; removed entry 110, pnl +20, half the margin released.
    r = applyFill(r.next, -ONE_BTC, notional(ticks(130), ONE_BTC));
    expect(r.closedLots).toBe(ONE_BTC);
    expect(r.realizedPnl).toBe(20n * USD);
    expect(r.releasedMargin).toBe(10n * USD);
    expect(r.next).toEqual({ size: ONE_BTC, entry: 110n * USD, margin: 10n * USD });

    r = applyFill(r.next, -ONE_BTC, notional(ticks(100), ONE_BTC));
    expect(r.realizedPnl).toBe(-10n * USD);
    expect(r.releasedMargin).toBe(10n * USD);
    expect(r.next).toEqual(FLAT);
  });

  it('short profits when the price falls', () => {
    const open = applyFill(FLAT, -ONE_BTC, notional(ticks(100), ONE_BTC));
    expect(open.next.entry).toBe(-100n * USD);
    const close = applyFill(open.next, ONE_BTC, notional(ticks(90), ONE_BTC));
    expect(close.realizedPnl).toBe(10n * USD);
    expect(close.next.size).toBe(0n);
  });

  it('flips a position: closes it and opens the remainder on the other side', () => {
    const long = applyFill(FLAT, ONE_BTC, notional(ticks(100), ONE_BTC)).next;
    const r = applyFill(
      { ...long, margin: 10n * USD },
      -3n * ONE_BTC,
      notional(ticks(110), 3n * ONE_BTC),
    );
    expect(r.closedLots).toBe(ONE_BTC);
    expect(r.openedLots).toBe(2n * ONE_BTC);
    expect(r.realizedPnl).toBe(10n * USD);
    expect(r.releasedMargin).toBe(10n * USD);
    expect(r.next).toEqual({ size: -2n * ONE_BTC, entry: -220n * USD, margin: 0n });
  });

  it('property: Σ entry = Σ realised PnL and Σ size = 0 across random trading', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            buyer: fc.integer({ min: 0, max: 4 }),
            seller: fc.integer({ min: 0, max: 4 }),
            price: fc.integer({ min: 1, max: 5_000_000 }),
            lots: fc.integer({ min: 1, max: 50_000 }),
          }),
          { maxLength: 200 },
        ),
        (trades) => {
          const pos: PositionState[] = Array.from({ length: 5 }, () => ({ ...FLAT }));
          let pnl = 0n;
          for (const t of trades) {
            if (t.buyer === t.seller) continue;
            const n = notional(BigInt(t.price), BigInt(t.lots));
            for (const [who, dq] of [
              [t.buyer, BigInt(t.lots)],
              [t.seller, -BigInt(t.lots)],
            ] as const) {
              const r = applyFill(pos[who]!, dq, n);
              expect(r.closeNotional + r.openNotional).toBe(n);
              // Opening a position adds margin; use 10% to exercise release paths.
              pos[who] = { ...r.next, margin: r.next.margin + r.openNotional / 10n };
              expect(pos[who].margin >= 0n).toBe(true);
              if (pos[who].size === 0n) {
                expect(pos[who].entry).toBe(0n);
                expect(pos[who].margin).toBe(0n);
              }
              pnl += r.realizedPnl;
            }
          }
          expect(pos.reduce((a, p) => a + p.size, 0n)).toBe(0n);
          expect(pos.reduce((a, p) => a + p.entry, 0n)).toBe(pnl);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('margin, bankruptcy and liquidation', () => {
  it('computes initial margin rounded up', () => {
    expect(initialMargin(100n * USD, 10)).toBe(10n * USD);
    expect(initialMargin(101n, 10)).toBe(11n);
  });

  it('bankruptcy price of a 10x long at 100 is 90 (short: 110)', () => {
    const long: PositionState = { size: ONE_BTC, entry: 100n * USD, margin: 10n * USD };
    expect(bankruptcyTicks(long, U)).toBe(ticks(90));
    expect(withinBankruptcy(long, ticks(90), U)).toBe(true);
    expect(withinBankruptcy(long, ticks(89.99), U)).toBe(false);
    const short: PositionState = { size: -ONE_BTC, entry: -100n * USD, margin: 10n * USD };
    expect(bankruptcyTicks(short, U)).toBe(ticks(110));
    expect(withinBankruptcy(short, ticks(110.01), U)).toBe(false);
  });

  it('property: closing at the bankruptcy price never loses more than the margin, one tick worse does', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10_000_000 }), // entry price ticks
        fc.integer({ min: 1, max: 100_000 }), // lots
        fc.integer({ min: 2, max: 100 }), // leverage
        fc.boolean(),
        (p, lots, lev, isLong) => {
          const size = isLong ? BigInt(lots) : -BigInt(lots);
          const n = notional(BigInt(p), BigInt(lots));
          const pos: PositionState = {
            size,
            entry: isLong ? n : -n,
            margin: initialMargin(n, lev),
          };
          const b = bankruptcyTicks(pos, U);
          const at = applyFill(pos, -size, notional(b, BigInt(lots)));
          expect(at.releasedMargin + at.realizedPnl >= 0n).toBe(true);
          const worse = isLong ? b - 1n : b + 1n;
          if (worse >= 1n) {
            const w = applyFill(pos, -size, notional(worse, BigInt(lots)));
            expect(w.releasedMargin + w.realizedPnl < 0n).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('liquidates when equity falls below maintenance margin', () => {
    const long: PositionState = { size: ONE_BTC, entry: 100n * USD, margin: 10n * USD };
    const mark = (price: number): bigint => BigInt(price) * USD;
    // MMR 5%: at 95 equity 5 vs MM 4.75 → safe; at 94 equity 4 vs MM 4.70 → liquidate.
    expect(equity(long, mark(95), U)).toBe(5n * USD);
    expect(isLiquidatable(long, mark(95), U, 500)).toBe(false);
    expect(isLiquidatable(long, mark(94), U, 500)).toBe(true);
    expect(isLiquidatable(FLAT, mark(1), U, 500)).toBe(false);
  });
});

describe('risk tiers', () => {
  const tiers = [
    { maxNotional: 10_000n * USD, maxLeverage: 20, mmrBps: 250 },
    { maxNotional: 100_000n * USD, maxLeverage: 10, mmrBps: 500 },
  ];
  it('validates and selects tiers', () => {
    expect(validateTiers(tiers)).toBeNull();
    expect(tierFor(tiers, 5_000n * USD)?.maxLeverage).toBe(20);
    expect(tierFor(tiers, 50_000n * USD)?.maxLeverage).toBe(10);
    expect(tierFor(tiers, 500_000n * USD)).toBeNull();
  });
  it('rejects unsafe tiers', () => {
    expect(validateTiers([])).not.toBeNull();
    expect(validateTiers([{ maxNotional: USD, maxLeverage: 50, mmrBps: 200 }])).toMatch(
      /below 10000/,
    );
    expect(validateTiers([...tiers].reverse())).toMatch(/increasing/);
  });
});

describe('index and mark price', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const at = (msAgo: number): Date => new Date(now.getTime() - msAgo);
  const opts = { staleMs: 10_000, outlierBps: 200, minSources: 2 };

  it('medians, rejects stale and outlier sources', () => {
    expect(medianBig([3n, 1n, 2n])).toBe(2n);
    expect(medianBig([4n, 1n, 2n, 3n])).toBe(2n);
    const r = computeIndex(
      [
        { price: 100_000n, observedAt: at(1000) },
        { price: 100_100n, observedAt: at(2000) },
        { price: 99_950n, observedAt: at(500) },
        { price: 150_000n, observedAt: at(100) }, // outlier
        { price: 100_000n, observedAt: at(60_000) }, // stale
        { price: null, observedAt: at(0) },
      ],
      now,
      opts,
    );
    expect(r).toEqual({ price: 100_000n, used: 3, rejectedStale: 2, rejectedOutliers: 1 });
  });

  it('has no index with too few reliable sources', () => {
    expect(computeIndex([{ price: 1n, observedAt: at(0) }], now, opts).price).toBeNull();
    expect(computeIndex([], now, opts).price).toBeNull();
  });

  it('clamps the mark around the index and averages the basis', () => {
    expect(markPrice(100_000n, 5_000n, 50)).toBe(100_500n);
    expect(markPrice(100_000n, -5_000n, 50)).toBe(99_500n);
    expect(markPrice(100_000n, 100n, 50)).toBe(100_100n);
    expect(emaStep(0n, 900n, 2)).toBe(600n);
  });
});

describe('funding', () => {
  it('computes and clamps the rate', () => {
    expect(premiumRate(101n, 100n)).toBe(RATE_SCALE / 100n);
    expect(fundingRate([], 75)).toBe(0n);
    expect(fundingRate([1_000n, 3_000n], 75)).toBe(2_000n);
    expect(fundingRate([RATE_SCALE], 75)).toBe(750_000n); // 0.75%
    expect(fundingRate([-RATE_SCALE], 75)).toBe(-750_000n);
  });

  it('longs pay shorts at a positive rate; never more than margin; zero-sum up to dust', () => {
    const mark = 100n * USD;
    const rate = RATE_SCALE / 1000n; // 0.1%
    const r = allocateFunding(
      [
        { id: 'L1', size: ONE_BTC, margin: 10n * USD },
        { id: 'L2', size: ONE_BTC, margin: 50n }, // can only pay 50
        { id: 'S1', size: -2n * ONE_BTC, margin: 10n * USD },
      ],
      mark,
      rate,
      U,
    );
    expect(r.transfers).toEqual([
      { id: 'L1', amount: -100_000n },
      { id: 'L2', amount: -50n },
      { id: 'S1', amount: 100_050n },
    ]);
    expect(r.collected).toBe(100_050n);
    expect(r.distributed).toBe(100_050n);
  });

  it('property: receivers never get more than was collected', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            size: fc.integer({ min: -100_000, max: 100_000 }),
            margin: fc.integer({ min: 0, max: 10_000_000 }),
          }),
          { maxLength: 30 },
        ),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (ps, rate, mark) => {
          const positions = ps.map((p, i) => ({
            id: String(i),
            size: BigInt(p.size),
            margin: BigInt(p.margin),
          }));
          const r = allocateFunding(positions, BigInt(mark), BigInt(rate), U);
          const paid = r.transfers.filter((t) => t.amount < 0n).reduce((a, t) => a - t.amount, 0n);
          const received = r.transfers
            .filter((t) => t.amount > 0n)
            .reduce((a, t) => a + t.amount, 0n);
          expect(paid).toBe(r.collected);
          expect(received).toBe(r.distributed);
          expect(received <= paid).toBe(true);
          for (const t of r.transfers) {
            const p = positions[Number(t.id)]!;
            if (t.amount < 0n) expect(-t.amount <= p.margin).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('ADL ranking (simulation)', () => {
  it('ranks profitable, highly leveraged positions first and skips losers', () => {
    const mark = 120n * USD;
    const ranked = adlRanking(
      [
        { id: 'low-lev', pos: { size: ONE_BTC, entry: 100n * USD, margin: 50n * USD } },
        { id: 'high-lev', pos: { size: ONE_BTC, entry: 100n * USD, margin: 5n * USD } },
        { id: 'loser', pos: { size: -ONE_BTC, entry: -100n * USD, margin: 50n * USD } },
      ],
      mark,
      U,
    );
    expect(ranked.map((r) => r.id)).toEqual(['high-lev', 'low-lev']);
  });

  it('notional helper rounds as requested', () => {
    expect(notionalAt(3n, 1n, { ...U, lotSize: 1n }, 'down')).toBe(0n);
    expect(notionalAt(3n, 1n, { ...U, lotSize: 1n }, 'up')).toBe(1n);
  });
});
