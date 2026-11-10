/**
 * Which wallet signs for the signed-in account (ADR-0035).
 *
 * - A browser extension wallet (MetaMask, Rabby, ...) exposes `window.ethereum`.
 * - An email wallet is created by Privy. Its key never reaches this app; Privy
 *   gives us an EIP-1193 provider. `EmbeddedWalletBridge` registers it here.
 *
 * Callers ask for the provider of the account's own address, so a stale email
 * wallet in the browser never signs for a different account.
 */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface EmbeddedWallet {
  address: string;
  provider: () => Promise<Eip1193>;
  switchChain: (chainId: number) => Promise<void>;
}

let embedded: EmbeddedWallet | null = null;

export function setEmbeddedWallet(wallet: EmbeddedWallet | null): void {
  embedded = wallet;
}

export function embeddedWalletAddress(): string | null {
  return embedded?.address ?? null;
}

export function injectedProvider(): Eip1193 | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}

/**
 * The provider for `address`: the email wallet when it is that address,
 * otherwise the browser extension. With `chainId`, the email wallet is moved
 * to that network first (extension wallets are switched by the caller).
 */
export async function walletProvider(
  address: string | null,
  chainId?: number,
): Promise<Eip1193 | null> {
  const e = embedded;
  if (e && address && e.address.toLowerCase() === address.toLowerCase()) {
    if (chainId !== undefined) await e.switchChain(chainId);
    // A provider is bound to the chain it was created on, so ask for a new one.
    return e.provider();
  }
  return injectedProvider();
}

export function toHex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
