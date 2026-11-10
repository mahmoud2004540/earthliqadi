import { TEST_NETWORKS } from '@platform/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailWalletChains } from './privy-config';
import { setEmbeddedWallet, walletProvider, type Eip1193 } from './wallet';

const fake = (name: string): Eip1193 => ({ request: () => Promise.resolve(name) });

afterEach(() => {
  setEmbeddedWallet(null);
  vi.unstubAllGlobals();
});

describe('walletProvider', () => {
  it('uses the email wallet only for its own address, after switching network', async () => {
    const embedded = fake('embedded');
    const switchChain = vi.fn(() => Promise.resolve());
    setEmbeddedWallet({
      address: '0xAbC0000000000000000000000000000000000001',
      provider: () => Promise.resolve(embedded),
      switchChain,
    });
    vi.stubGlobal('window', { ethereum: fake('extension') });

    expect(await walletProvider('0xabc0000000000000000000000000000000000001', 84532)).toBe(
      embedded,
    );
    expect(switchChain).toHaveBeenCalledWith(84532);

    // Another account: never the email wallet.
    const other = await walletProvider('0x0000000000000000000000000000000000000002', 84532);
    expect(await other!.request({ method: 'x' })).toBe('extension');
    expect(switchChain).toHaveBeenCalledTimes(1);
  });

  it('falls back to the extension wallet, or null without one', async () => {
    expect(await walletProvider('0x01')).toBeNull();
    vi.stubGlobal('window', { ethereum: fake('extension') });
    expect(await (await walletProvider(null))!.request({ method: 'x' })).toBe('extension');
  });
});

describe('emailWalletChains', () => {
  it('is exactly the allowed test networks', () => {
    expect(emailWalletChains().map((c) => c.id)).toEqual(TEST_NETWORKS.map((n) => n.chainId));
  });
});
