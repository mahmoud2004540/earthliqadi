import { expect, test } from '@playwright/test';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.E2E_CHAIN_RPC_URL ?? 'http://localhost:8545';

/**
 * Deposit and withdraw through the non-custodial vault on the local chain,
 * with an injected EIP-1193 wallet whose key stays in the Node test process.
 */
test('vault: test tokens, deposit, credited after confirmations, withdraw to the wallet', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const asset = process.env.E2E_VAULT_USD!;
  const account = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({ account, transport: http(RPC) });
  const chain = createPublicClient({ transport: http(RPC) });

  await page.exposeFunction('__wallet', async (method: string, params: unknown[]) => {
    if (method === 'personal_sign') {
      return account.signMessage({ message: { raw: params[0] as Hex } });
    }
    if (method === 'eth_sendTransaction') {
      const tx = params[0] as { to: Hex; data: Hex };
      return wallet.sendTransaction({ to: tx.to, data: tx.data, chain: null });
    }
    if (method === 'eth_getTransactionReceipt') {
      const r = await chain.getTransactionReceipt({ hash: params[0] as Hex }).catch(() => null);
      return r ? { status: r.status === 'success' ? '0x1' : '0x0' } : null;
    }
    throw new Error(`unsupported ${method}`);
  });
  await page.addInitScript((address: string) => {
    const call = (window as unknown as { __wallet: (m: string, p: unknown[]) => Promise<unknown> })
      .__wallet;
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts')
          return Promise.resolve([address]);
        if (method === 'eth_chainId') return Promise.resolve('0x7a69');
        return call(method, params ?? []);
      },
    };
  }, account.address);

  await page.goto('/connect');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.waitForURL('**/dashboard');
  await page.getByRole('tab', { name: 'Balances' }).click();
  const vault = page.getByTestId('vault-panel');
  await expect(vault).toBeVisible();
  await vault.getByRole('button', { name: 'Get test tokens & gas' }).click();
  await expect(vault.getByText('Test tokens and gas sent to your wallet.')).toBeVisible();

  await vault.locator('#vault-asset').selectOption(asset);
  await vault.locator('#vault-amount').fill('100');
  await vault.getByRole('button', { name: 'Deposit' }).click();
  await expect(vault.getByText(/Deposit sent/)).toBeVisible({ timeout: 60_000 });

  // The indexer credits it after the confirmations (block time 1 s, 2 confirmations).
  await expect
    .poll(
      async () => {
        await page.reload();
        await page.getByRole('tab', { name: 'Balances' }).click();
        // Zero balances are hidden: the row appears once the deposit is credited.
        const row = page.getByRole('row').filter({ hasText: asset });
        return (await row.count()) > 0 ? row.first().innerText() : '';
      },
      { timeout: 60_000, intervals: [2000] },
    )
    .toContain('100.000000');

  await page.getByTestId('vault-panel').locator('#vault-asset').selectOption(asset);
  await page.getByTestId('vault-panel').locator('#vault-amount').fill('40');
  await page.getByTestId('vault-panel').getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByText(/Withdrawal submitted/)).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => {
        await page.reload();
        await page.getByRole('tab', { name: 'Balances' }).click();
        return page.getByTestId('withdrawals').innerText();
      },
      { timeout: 60_000, intervals: [2000] },
    )
    .toContain('Executed');
});
