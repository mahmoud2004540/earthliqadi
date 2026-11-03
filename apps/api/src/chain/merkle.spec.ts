import fc from 'fast-check';
import type { Hex } from 'viem';
import { EMPTY_ROOT, buildTree, leafHash, proofFor, verifyProof, type BalanceLeaf } from './merkle';

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`;

describe('vault balance tree', () => {
  it('handles empty and single-leaf trees', () => {
    expect(buildTree([]).root).toBe(EMPTY_ROOT);
    const one: BalanceLeaf = { wallet: addr(1), token: addr(2), balance: 5n };
    const t = buildTree([one]);
    expect(t.root).toBe(leafHash(one));
    expect(proofFor(t.levels, leafHash(one))).toEqual([]);
  });

  it('property: every leaf has a valid proof, and a changed balance does not verify', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 40 }),
        (ids) => {
          const leaves = ids.map((i) => ({
            wallet: addr(i),
            token: addr(7),
            balance: BigInt(i) * 3n,
          }));
          const { root, levels } = buildTree(leaves);
          for (const l of leaves) {
            const proof = proofFor(levels, leafHash(l))!;
            expect(verifyProof(proof, root, leafHash(l))).toBe(true);
            expect(verifyProof(proof, root, leafHash({ ...l, balance: l.balance + 1n }))).toBe(
              false,
            );
          }
          // Order of input does not matter.
          expect(buildTree([...leaves].reverse()).root).toBe(root);
        },
      ),
      { numRuns: 100 },
    );
  });
});
