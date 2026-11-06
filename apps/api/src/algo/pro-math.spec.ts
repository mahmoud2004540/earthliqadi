import {
  chaseNeedsReprice,
  chaseTarget,
  gridCounter,
  gridLevels,
  initialGridOrders,
  protectionPrice,
  scalePlan,
  trailingStep,
} from './pro-math';

describe('trailingStep', () => {
  const sell = { side: 'SELL' as const, callbackBps: 100, activation: null };
  it('tracks the peak and triggers a sell after a 1% retrace', () => {
    let s = { activated: false, extreme: null as bigint | null };
    for (const p of [10_000n, 10_200n, 10_500n]) s = trailingStep(s, sell, p);
    expect(s.extreme).toBe(10_500n);
    expect(trailingStep(s, sell, 10_400n).triggered).toBe(false);
    expect(trailingStep(s, sell, 10_395n).triggered).toBe(true); // 10_500 × 0.99
  });
  it('tracks the trough and triggers a buy after a rise', () => {
    const buy = { side: 'BUY' as const, callbackBps: 200, activation: null };
    let s = trailingStep({ activated: false, extreme: null }, buy, 10_000n);
    s = trailingStep(s, buy, 9_000n);
    expect(s.extreme).toBe(9_000n);
    expect(trailingStep(s, buy, 9_179n).triggered).toBe(false);
    expect(trailingStep(s, buy, 9_180n).triggered).toBe(true);
  });
  it('waits for the activation price', () => {
    const p = { ...sell, activation: 11_000n };
    let s = trailingStep({ activated: false, extreme: null }, p, 10_000n);
    expect(s).toEqual({ activated: false, extreme: null, triggered: false });
    s = trailingStep(s, p, 11_000n);
    expect(s).toMatchObject({ activated: true, extreme: 11_000n, triggered: false });
    expect(trailingStep(s, p, 10_000n).triggered).toBe(true);
  });
  it('bounds the protection price', () => {
    expect(protectionPrice('SELL', 10_000n, 100)).toBe(9_900n);
    expect(protectionPrice('BUY', 10_001n, 100)).toBe(10_102n); // rounded up
    expect(protectionPrice('SELL', 1n, 1000)).toBe(1n);
  });
});

describe('chase', () => {
  it('joins the best price on its own side, within the cap', () => {
    expect(chaseTarget('BUY', { bid: 100n, ask: 105n }, 200n)).toBe(100n);
    expect(chaseTarget('BUY', { bid: 150n, ask: 155n }, 120n)).toBe(120n);
    expect(chaseTarget('BUY', { bid: null, ask: 105n }, 200n)).toBe(104n);
    expect(chaseTarget('BUY', { bid: null, ask: null }, 200n)).toBe(200n);
    expect(chaseTarget('SELL', { bid: 100n, ask: 105n }, 90n)).toBe(105n);
    expect(chaseTarget('SELL', { bid: 100n, ask: 95n }, 99n)).toBe(99n);
    expect(chaseTarget('SELL', { bid: 100n, ask: null }, 50n)).toBe(101n);
  });
  it('reprices only when the market moved past the resting order', () => {
    expect(chaseNeedsReprice('BUY', 100n, 101n)).toBe(true);
    expect(chaseNeedsReprice('BUY', 100n, 100n)).toBe(false);
    expect(chaseNeedsReprice('SELL', 105n, 104n)).toBe(true);
    expect(chaseNeedsReprice('SELL', 105n, 106n)).toBe(false);
  });
});

describe('scalePlan', () => {
  const base = { start: 100n, end: 104n, count: 5, minLots: 1n };
  it('spreads size evenly over evenly spaced prices', () => {
    expect(scalePlan({ ...base, totalLots: 12n, distribution: 'flat' })).toEqual([
      { priceTicks: 100n, lots: 4n },
      { priceTicks: 101n, lots: 2n },
      { priceTicks: 102n, lots: 2n },
      { priceTicks: 103n, lots: 2n },
      { priceTicks: 104n, lots: 2n },
    ]);
  });
  it('weights size towards the end or the start', () => {
    const inc = scalePlan({ ...base, totalLots: 15n, distribution: 'increasing' });
    expect(inc.map((o) => o.lots)).toEqual([1n, 2n, 3n, 4n, 5n]);
    const dec = scalePlan({ ...base, totalLots: 15n, distribution: 'decreasing' });
    expect(dec.map((o) => o.lots)).toEqual([5n, 4n, 3n, 2n, 1n]);
  });
  it('keeps the total and handles descending ranges with rounding', () => {
    const plan = scalePlan({
      totalLots: 1000n,
      start: 200n,
      end: 100n,
      count: 3,
      minLots: 1n,
      distribution: 'flat',
    });
    expect(plan.map((o) => o.priceTicks)).toEqual([200n, 150n, 100n]);
    expect(plan.reduce((a, o) => a + o.lots, 0n)).toBe(1000n);
    const odd = scalePlan({ ...base, end: 107n, count: 3, totalLots: 3n, distribution: 'flat' });
    expect(odd.map((o) => o.priceTicks)).toEqual([100n, 104n, 107n]); // 103.5 rounds up
  });
  it('refuses tiny orders, narrow ranges and bad counts', () => {
    expect(() => scalePlan({ ...base, totalLots: 4n, distribution: 'flat' })).toThrow(/minimum/);
    expect(() => scalePlan({ ...base, end: 102n, totalLots: 50n, distribution: 'flat' })).toThrow(
      /too narrow/,
    );
    expect(() => scalePlan({ ...base, count: 21, totalLots: 500n, distribution: 'flat' })).toThrow(
      /2-20/,
    );
  });
});

describe('grid', () => {
  it('builds arithmetic levels', () => {
    expect(gridLevels(100n, 200n, 4)).toEqual([100n, 125n, 150n, 175n, 200n]);
    expect(() => gridLevels(100n, 103n, 4)).toThrow(/too narrow/);
    expect(() => gridLevels(200n, 100n, 4)).toThrow(/above/);
  });
  it('places buys below and sells above the reference by direction', () => {
    const levels = gridLevels(100n, 200n, 4);
    expect(initialGridOrders(levels, 150n, 'LONG')).toEqual([
      { level: 0, side: 'BUY' },
      { level: 1, side: 'BUY' },
    ]);
    expect(initialGridOrders(levels, 150n, 'SHORT')).toEqual([
      { level: 3, side: 'SELL' },
      { level: 4, side: 'SELL' },
    ]);
    expect(initialGridOrders(levels, 160n, 'NEUTRAL')).toEqual([
      { level: 0, side: 'BUY' },
      { level: 1, side: 'BUY' },
      { level: 2, side: 'BUY' },
      { level: 3, side: 'SELL' },
      { level: 4, side: 'SELL' },
    ]);
  });
  it('answers a fill one level away, never past the edges', () => {
    expect(gridCounter('BUY', 1, 5)).toEqual({ level: 2, side: 'SELL' });
    expect(gridCounter('SELL', 3, 5)).toEqual({ level: 2, side: 'BUY' });
    expect(gridCounter('BUY', 4, 5)).toBeNull();
    expect(gridCounter('SELL', 0, 5)).toBeNull();
  });
});
