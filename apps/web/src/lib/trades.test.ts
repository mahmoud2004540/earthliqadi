import { describe, expect, it } from 'vitest';
import { mergeTrades } from './trades';

const t = (seq: number) => ({
  seq: String(seq),
  price: '1',
  quantity: '1',
  takerSide: 'buy' as const,
  executedAt: new Date(seq * 1000).toISOString(),
});

describe('mergeTrades', () => {
  it('never shows a trade twice and keeps newest first', () => {
    const merged = mergeTrades([t(3), t(2), t(1)], [t(5), t(4), t(3), t(2)]);
    expect(merged.map((x) => x.seq)).toEqual(['5', '4', '3', '2', '1']);
  });

  it('caps the list at 60 entries', () => {
    const many = Array.from({ length: 100 }, (_, i) => t(i + 1));
    const merged = mergeTrades([], many);
    expect(merged).toHaveLength(60);
    expect(merged[0]!.seq).toBe('100');
  });
});
