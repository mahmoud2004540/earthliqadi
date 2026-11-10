import { TEST_NETWORKS } from '@platform/shared';
import type { Chain } from 'viem';
import { arbitrumSepolia, baseSepolia, foundry, holesky, sepolia } from 'viem/chains';

/** viem definitions of the allowed test networks (ADR-0034). Mainnets are absent. */
const CHAINS: Record<number, Chain> = {
  [foundry.id]: foundry,
  [sepolia.id]: sepolia,
  [holesky.id]: holesky,
  [baseSepolia.id]: baseSepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
};

/** Networks an email wallet may use: exactly the test networks the vault may run on. */
export function emailWalletChains(): Chain[] {
  return TEST_NETWORKS.flatMap((n) => {
    const chain = CHAINS[n.chainId];
    return chain ? [chain] : [];
  });
}

/** The Privy app id, or null when email wallets are not configured. */
export function privyAppId(): string | null {
  const id = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  return id && id.length > 0 ? id : null;
}
