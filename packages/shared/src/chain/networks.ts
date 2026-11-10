/**
 * Test networks the vault may run on (ADR-0014, ADR-0034). Only chains
 * without real value are listed; mainnets are deliberately absent.
 */
export interface TestNetwork {
  chainId: number;
  name: string;
  /** Public RPC offered to wallets when they add the network. */
  rpcUrl: string;
  /** Block explorer, without a trailing slash; null for the local chain. */
  explorerUrl: string | null;
  /** Where users get free test ETH for gas; null for the local chain. */
  gasFaucetInfo: string | null;
}

export const TEST_NETWORKS: readonly TestNetwork[] = [
  {
    chainId: 31337,
    name: 'Local test chain (no value)',
    rpcUrl: 'http://localhost:8545',
    explorerUrl: null,
    gasFaucetInfo: null,
  },
  {
    chainId: 11155111,
    name: 'Sepolia (testnet, no value)',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    gasFaucetInfo: 'Sepolia ETH',
  },
  {
    chainId: 17000,
    name: 'Holesky (testnet, no value)',
    rpcUrl: 'https://ethereum-holesky-rpc.publicnode.com',
    explorerUrl: 'https://holesky.etherscan.io',
    gasFaucetInfo: 'Holesky ETH',
  },
  {
    chainId: 84532,
    name: 'Base Sepolia (testnet, no value)',
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    gasFaucetInfo: 'Base Sepolia ETH',
  },
  {
    chainId: 421614,
    name: 'Arbitrum Sepolia (testnet, no value)',
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorerUrl: 'https://sepolia.arbiscan.io',
    gasFaucetInfo: 'Arbitrum Sepolia ETH',
  },
];

export function testNetwork(chainId: number): TestNetwork | null {
  return TEST_NETWORKS.find((n) => n.chainId === chainId) ?? null;
}

/**
 * Networks with REAL value (ADR-0038). Used only when the server runs with
 * CHAIN_MAINNET=true. Addresses were checked against the issuer's official
 * page and on-chain (name, symbol, decimals) on 2026-11-10.
 */
export interface MainNetwork extends TestNetwork {
  /** Circle's native USDC on this network. */
  usdc: string;
}

export const MAINNET_NETWORKS: readonly MainNetwork[] = [
  {
    chainId: 8453,
    name: 'Base',
    // Public, rate-limited RPC offered to wallets only; the server needs its own provider.
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    gasFaucetInfo: null,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
];

export function mainNetwork(chainId: number): MainNetwork | null {
  return MAINNET_NETWORKS.find((n) => n.chainId === chainId) ?? null;
}
