/**
 * Risk simulation harness (ADR-0011). Replays a SYNTHETIC mark-price path
 * through a set of isolated positions to exercise liquidation, the insurance
 * fund and auto-deleveraging (ADL) without touching the ledger. ADL is not
 * live; it exists here so its behaviour can be specified and tested first.
 *
 * Model: every trader's counterparty is a liquidity provider (LP) with
 * unlimited collateral. A liquidated position is taken over by the LP at the
 * current mark. Losses beyond the margin are paid by the insurance fund; when
 * the fund is empty, the remaining deficit is charged to the most profitable
 * opposite positions by ADL rank.
 */
import type { MarketUnits } from '../trading/order-math';
import {
  adlRanking,
  applyFill,
  initialMargin,
  isLiquidatable,
  notionalAt,
  unrealizedPnl,
  type PositionState,
} from './perp-math';

export interface SimTrader {
  id: string;
  /** Signed lots. */
  size: bigint;
  leverage: number;
}

export interface SimInput {
  units: MarketUnits;
  entryPrice: bigint;
  path: bigint[];
  traders: SimTrader[];
  mmrBps: number;
  liquidationFeeBps: number;
  insuranceFund: bigint;
}

export interface SimResult {
  /** Cash returned to each trader (margin + realised PnL − fees), when closed. */
  cash: Map<string, bigint>;
  open: Map<string, PositionState>;
  lp: PositionState & { cash: bigint };
  insuranceFund: bigint;
  liquidations: number;
  /** Deficit charged to profitable traders via ADL. */
  adlDeficit: bigint;
  adlEvents: { step: number; id: string; amount: bigint }[];
}

export function simulate(input: SimInput): SimResult {
  const u = input.units;
  const open = new Map<string, PositionState>();
  const cash = new Map<string, bigint>();
  let lp: PositionState & { cash: bigint } = { size: 0n, entry: 0n, margin: 0n, cash: 0n };
  let insurance = input.insuranceFund;
  let liquidations = 0;
  let adlDeficit = 0n;
  const adlEvents: SimResult['adlEvents'] = [];

  const lpFill = (dq: bigint, n: bigint): void => {
    const r = applyFill(lp, dq, n);
    lp = { ...r.next, cash: lp.cash + r.realizedPnl };
  };

  for (const t of input.traders) {
    if (t.size === 0n) continue;
    const n = notionalAt(input.entryPrice, t.size, u);
    if (n === 0n) continue;
    const opened = applyFill({ size: 0n, entry: 0n, margin: 0n }, t.size, n).next;
    open.set(t.id, { ...opened, margin: initialMargin(n, t.leverage) });
    lpFill(-t.size, n);
  }

  input.path.forEach((mark, step) => {
    for (const [id, pos] of [...open]) {
      if (!isLiquidatable(pos, mark, u, input.mmrBps)) continue;
      const n = notionalAt(mark, pos.size, u);
      if (n === 0n) continue;
      const r = applyFill(pos, -pos.size, n);
      lpFill(pos.size, n); // the LP takes the position over at the mark
      let payout = r.releasedMargin + r.realizedPnl;
      liquidations++;
      if (payout >= 0n) {
        const fee = (n * BigInt(input.liquidationFeeBps)) / 10_000n;
        const paid = fee < payout ? fee : payout;
        insurance += paid;
        payout -= paid;
      } else {
        let deficit = -payout;
        const fromFund = deficit < insurance ? deficit : insurance;
        insurance -= fromFund;
        deficit -= fromFund;
        payout = 0n;
        if (deficit > 0n) {
          // ADL: charge the deficit to profitable OPPOSITE positions, best-ranked first.
          const candidates = [...open]
            .filter(([oid, p]) => oid !== id && p.size !== 0n && p.size > 0n !== pos.size > 0n)
            .map(([oid, p]) => ({ id: oid, pos: p }));
          for (const c of adlRanking(candidates, mark, u)) {
            if (deficit === 0n) break;
            const p = open.get(c.id)!;
            const profit = unrealizedPnl(p, mark, u);
            const take = deficit < profit ? deficit : profit;
            // The profitable position gives up `take` of value: margin first, then
            // unrealised profit (raising the entry lowers PnL for longs and shorts).
            const fromMargin = take < p.margin ? take : p.margin;
            open.set(c.id, {
              ...p,
              margin: p.margin - fromMargin,
              entry: p.entry + (take - fromMargin),
            });
            adlEvents.push({ step, id: c.id, amount: take });
            adlDeficit += take;
            deficit -= take;
          }
          // Whatever nobody could cover stays with the counterparty (the LP).
          lp = { ...lp, cash: lp.cash - deficit };
        }
      }
      cash.set(id, payout);
      open.delete(id);
    }
  });

  return { cash, open, lp, insuranceFund: insurance, liquidations, adlDeficit, adlEvents };
}
