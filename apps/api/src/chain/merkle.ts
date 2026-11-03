import { encodeAbiParameters, keccak256, type Hex } from 'viem';

/**
 * Balance tree for vault state commitments (ADR-0014). Must match
 * ExchangeVault.leaf() and ExchangeVault._verify():
 *   leaf  = keccak256(keccak256(abi.encode(user, token, balance)))
 *   node  = keccak256(abi.encode(min(a, b), max(a, b)))  (sorted pairs)
 * An odd node is carried up unchanged (no duplication).
 */
export interface BalanceLeaf {
  wallet: Hex;
  token: Hex;
  balance: bigint;
}

export function leafHash(l: BalanceLeaf): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [l.wallet, l.token, l.balance],
    ),
  );
  return keccak256(inner);
}

function pair(a: Hex, b: Hex): Hex {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [x, y]));
}

export const EMPTY_ROOT: Hex = `0x${'0'.repeat(64)}`;

/** Builds all levels; level 0 = leaf hashes sorted ascending (deterministic). */
export function buildTree(leaves: BalanceLeaf[]): { root: Hex; levels: Hex[][] } {
  if (leaves.length === 0) return { root: EMPTY_ROOT, levels: [[]] };
  const level0 = leaves.map(leafHash).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const levels: Hex[][] = [level0];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2)
      next.push(i + 1 < prev.length ? pair(prev[i]!, prev[i + 1]!) : prev[i]!);
    levels.push(next);
  }
  return { root: levels[levels.length - 1]![0]!, levels };
}

export function proofFor(levels: Hex[][], leaf: Hex): Hex[] | null {
  let idx = levels[0]!.indexOf(leaf);
  if (idx < 0) return null;
  const proof: Hex[] = [];
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l]!;
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling < level.length) proof.push(level[sibling]!);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(proof: Hex[], root: Hex, leaf: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = pair(h, p);
  return h === root;
}
