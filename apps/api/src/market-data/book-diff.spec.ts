import fc from 'fast-check';
import type { BookLevel } from '@platform/shared';
import { applyLevels, diffLevels } from './book-diff';

const side = (desc: boolean) =>
  fc
    .uniqueArray(fc.integer({ min: 1, max: 500 }), { maxLength: 30 })
    .chain((prices) =>
      fc.tuple(
        ...prices.map((p) =>
          fc.integer({ min: 1, max: 9 }).map((q) => [`${p}.00`, `${q}.5`] as BookLevel),
        ),
      ),
    )
    .map((levels) => [...levels].sort((a, b) => (desc ? -1 : 1) * (Number(a[0]) - Number(b[0]))));

describe('book diffs', () => {
  it('reports changed, new and removed levels', () => {
    const prev: BookLevel[] = [
      ['101', '1'],
      ['100', '2'],
      ['99', '3'],
    ];
    const next: BookLevel[] = [
      ['101', '1'],
      ['100', '5'],
      ['98', '4'],
    ];
    expect(diffLevels(prev, next)).toEqual([
      ['100', '5'],
      ['98', '4'],
      ['99', '0'],
    ]);
    expect(diffLevels(next, next)).toEqual([]);
  });

  it('applying the diff to the previous view reproduces the next view (property)', () => {
    fc.assert(
      fc.property(side(true), side(true), (prev, next) => {
        expect(applyLevels(prev, diffLevels(prev, next), 'bids')).toEqual(next);
      }),
    );
    fc.assert(
      fc.property(side(false), side(false), (prev, next) => {
        expect(applyLevels(prev, diffLevels(prev, next), 'asks')).toEqual(next);
      }),
    );
  });
});
