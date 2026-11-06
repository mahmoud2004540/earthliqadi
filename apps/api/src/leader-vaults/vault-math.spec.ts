import fc from 'fast-check';
import {
  E18,
  blendedHwm,
  drawdownBps,
  leaderShareBps,
  ppsE18,
  redeem,
  sharesForDeposit,
} from './vault-math';

describe('leader-vault share accounting', () => {
  it('mints shares at the current price and never dilutes existing holders', () => {
    expect(sharesForDeposit(1000n, 0n, 0n)).toBe(1000n);
    // Equity doubled: a new 1000 buys half as many shares.
    expect(sharesForDeposit(1000n, 2000n, 1000n)).toBe(500n);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        (amount, equity, total) => {
          const minted = sharesForDeposit(amount, equity, total);
          // Price per share after the deposit is not lower than before.
          expect(ppsE18(equity + amount, total + minted) >= ppsE18(equity, total)).toBe(true);
        },
      ),
    );
  });

  it('charges profit share only above the high-water mark, never on the leader', () => {
    // 100 shares, equity 150 (pps 1.5), hwm 1.0, 20% profit share.
    const r = redeem(100n, 150n, 100n, E18, 2000, false);
    expect(r).toEqual({ gross: 150n, profitShare: 10n, net: 140n, hwmE18: (3n * E18) / 2n });
    // Below the mark: nothing is charged.
    expect(redeem(100n, 80n, 100n, E18, 2000, false).profitShare).toBe(0n);
    expect(redeem(100n, 150n, 100n, E18, 2000, true).profitShare).toBe(0n);
  });

  it('pays out at most the gross value (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        fc.integer({ min: 0, max: 3000 }),
        (total, equity, hwmUnits, bps) => {
          const shares = total / 2n + 1n;
          const r = redeem(shares, equity, total, hwmUnits * (E18 / 1000n), bps, false);
          expect(r.net + r.profitShare).toBe(r.gross);
          expect(r.net >= 0n && r.profitShare >= 0n).toBe(true);
          expect(r.gross * total <= shares * equity).toBe(true);
        },
      ),
    );
  });

  it('blends the high-water mark, measures leader share and drawdown', () => {
    expect(blendedHwm(100n, E18, 100n, 2n * E18)).toBe((3n * E18) / 2n);
    expect(leaderShareBps(5n, 100n)).toBe(500n);
    expect(drawdownBps(E18, (8n * E18) / 10n)).toBe(2000n);
    expect(drawdownBps(E18, 2n * E18)).toBe(0n);
  });
});
