import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { expect, test } from '@playwright/test';

/**
 * A test wallet injected as an EIP-1193 provider. Keys stay in the Node test
 * process: the page only asks it to sign, like a real extension would.
 */
function testWallet() {
  const key = secp256k1.utils.randomPrivateKey();
  const pub = secp256k1.getPublicKey(key, false);
  const address = `0x${Buffer.from(keccak_256(pub.slice(1)).slice(-20)).toString('hex')}`;
  const personalSign = (hexMessage: string): string => {
    const body = Buffer.from(hexMessage.slice(2), 'hex');
    const digest = keccak_256(
      Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`), body]),
    );
    const sig = secp256k1.sign(digest, key);
    return `0x${Buffer.from(sig.toCompactRawBytes()).toString('hex')}${(27 + sig.recovery).toString(16)}`;
  };
  return { address, personalSign };
}

test('sign in with a wallet: no email, no password, no identity documents', async ({ page }) => {
  const wallet = testWallet();
  await page.exposeFunction('__testWalletSign', (hex: string) => wallet.personalSign(hex));
  await page.addInitScript((address: string) => {
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method, params }: { method: string; params?: string[] }) => {
        if (method === 'eth_requestAccounts') return [address];
        if (method === 'eth_chainId') return '0xaa36a7'; // Sepolia testnet
        if (method === 'personal_sign')
          return (
            window as unknown as { __testWalletSign(h: string): Promise<string> }
          ).__testWalletSign(params![0]!);
        throw new Error(`unsupported ${method}`);
      },
    };
  }, wallet.address);

  await page.goto('/');
  await page.getByRole('link', { name: 'Connect wallet' }).first().click();
  await expect(page.getByTestId('wallet-connect')).toBeVisible();
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.waitForURL('**/dashboard');
  // The checksummed address is the identity.
  await expect(page.getByText(new RegExp(wallet.address.slice(2, 10), 'i'))).toBeVisible();
  await expect(page.getByText('Wallet signature')).toBeVisible();
  await page.getByRole('tab', { name: 'Security' }).click();
  await expect(page.getByText('Change password')).toHaveCount(0);

  // A second visit signs the same account back in.
  await page.context().clearCookies();
  await page.goto('/connect');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.waitForURL('**/dashboard');
});
