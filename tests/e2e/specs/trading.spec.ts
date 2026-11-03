import { expect, test, type Browser, type Page } from '@playwright/test';
import { PASSWORD, cli, uniqueEmail, verificationLink } from '../stack';

const E2E_MARKET = process.env.E2E_MARKET!;
const BASE = process.env.E2E_BASE!;
const QUOTE = process.env.E2E_QUOTE!;

async function signUp(browser: Browser, tag: string, deposit?: [string, string]): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const email = uniqueEmail(tag);
  await page.goto('/register');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.check('#terms');
  await page.click('button[type=submit]');
  await expect(page.getByText('Check your inbox')).toBeVisible();
  await expect
    .poll(() => {
      try {
        return verificationLink(email);
      } catch {
        return '';
      }
    })
    .not.toBe('');
  await page.goto(verificationLink(email));
  await expect(page.getByText('Your email is verified')).toBeVisible();
  if (deposit)
    cli(
      'dist/cli/ledger.js',
      'sim-deposit',
      '--email',
      email,
      '--asset',
      deposit[0],
      '--amount',
      deposit[1],
    );
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard');
  return page;
}

test('public pages are English-only and legacy locale URLs redirect', async ({ page }) => {
  await page.goto('/en/trust');
  await expect(page).toHaveURL(/\/trust$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  expect(/[؀-ۿ]/.test(await page.content())).toBe(false);
});

test('markets page lists real markets', async ({ page }) => {
  await page.goto('/markets');
  await expect(page.getByTestId('markets-table')).toContainText(E2E_MARKET.replace('-', ' / '));
});

test('two users trade through the terminal with live updates', async ({ browser }) => {
  const seller = await signUp(browser, 'e2e-seller', [BASE, '2']);
  const buyer = await signUp(browser, 'e2e-buyer', [QUOTE, '100000']);
  for (const page of [seller, buyer]) {
    await page.goto(`/trade/${E2E_MARKET}`);
    await expect(page.getByTestId('order-form')).toBeVisible();
    await expect(page.getByTestId('stream-status')).toHaveCount(0); // connected and live
  }
  const price = (1000 + Math.floor(Math.random() * 8000)).toString();

  await seller.getByRole('button', { name: 'Sell', exact: true }).click();
  await seller.fill('#price', price);
  await seller.fill('#quantity', '0.5');
  await expect(seller.getByTestId('order-total')).toHaveText(`0.5 ${BASE}`);
  await seller.getByTestId('order-form').locator('button[type=submit]').click();

  // Live order book update over WebSocket in the other browser.
  const level = buyer
    .getByTestId('order-book')
    .getByRole('button', { name: new RegExp(`^${price}`) });
  await expect(level).toBeVisible();
  await level.click();
  await expect(buyer.locator('#price')).toHaveValue(price);
  await buyer.fill('#quantity', '0.2');
  // Exact expected total (bigint): price × 0.2. Floats would give e.g. 1141.6000000000001.
  const tenths = BigInt(price) * 2n;
  const total = `${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ''}`;
  await expect(buyer.getByTestId('order-total')).toHaveText(`${total} ${QUOTE}`);
  await buyer.getByTestId('order-form').locator('button[type=submit]').click();

  await expect(buyer.getByTestId('recent-trades')).toContainText(price);
  await buyer.getByRole('tab', { name: 'My trades' }).click();
  await expect(buyer.getByTestId('my-orders')).toContainText('taker');
  await expect(buyer.getByTestId('my-orders')).toContainText(`0.0004 ${BASE}`); // 0.20% taker fee on 0.2

  await expect(seller.getByTestId('order-row').first()).toContainText('partially filled');
  await seller.getByTestId('order-row').first().getByRole('button', { name: 'Cancel' }).click();
  await seller.getByRole('tab', { name: 'Order history' }).click();
  await expect(seller.getByTestId('order-row').first()).toContainText('cancelled');
});

test('signed-out visitors see the market but must sign in to trade', async ({ page }) => {
  await page.goto(`/trade/${E2E_MARKET}`);
  await expect(page.getByTestId('order-book')).toBeVisible();
  await expect(page.getByText('Sign in to trade')).toBeVisible();
});

test('paper trading: faucet funds and a trade on a paper market', async ({ browser }) => {
  const market = process.env.E2E_PAPER_MARKET!;
  const [base, quote] = market.split('-') as [string, string];
  const seller = await signUp(browser, 'e2e-paper-seller');
  const buyer = await signUp(browser, 'e2e-paper-buyer');
  for (const [page, asset] of [
    [seller, base],
    [buyer, quote],
  ] as const) {
    await page.goto(`/trade/${market}`);
    await expect(page.getByTestId('paper-badge')).toBeVisible();
    await page
      .getByTestId('paper-faucet')
      .getByRole('button', { name: `Get paper ${asset}` })
      .click();
    await expect(page.getByText('Paper funds added.')).toBeVisible();
  }
  await seller.getByRole('button', { name: 'Sell', exact: true }).click();
  await expect(seller.getByTestId('available')).toHaveText(`2.00000000 ${base}`);
  await seller.fill('#price', '100');
  await seller.fill('#quantity', '1');
  await seller.getByTestId('order-form').locator('button[type=submit]').click();
  await expect(buyer.getByTestId('order-book').getByRole('button', { name: /^100/ })).toBeVisible();
  await buyer.fill('#price', '100');
  await buyer.fill('#quantity', '1');
  await buyer.getByTestId('order-form').locator('button[type=submit]').click();
  await expect(buyer.getByTestId('recent-trades')).toContainText('100');
  // The faucet is limited to once per asset per day.
  await buyer
    .getByTestId('paper-faucet')
    .getByRole('button', { name: `Get paper ${quote}` })
    .click();
  await expect(buyer.getByText(/already used/)).toBeVisible();
});

test('perpetuals (paper): mark price, leverage, opening a position', async ({ browser }) => {
  const market = process.env.E2E_PERP_MARKET!;
  const quote = market.split('-')[1]!;
  const long = await signUp(browser, 'e2e-perp-long');
  const short = await signUp(browser, 'e2e-perp-short');
  for (const page of [long, short]) {
    await page.goto(`/trade/${market}`);
    await expect(page.getByTestId('perp-badge')).toBeVisible();
    await expect(page.getByTestId('perp-mark')).not.toHaveText('—');
    await page
      .getByTestId('paper-faucet')
      .getByRole('button', { name: `Get paper ${quote}` })
      .click();
    await expect(page.getByText('Paper funds added.')).toBeVisible();
  }
  await expect(long.getByTestId('leverage')).toHaveText('10x');
  // A price on the tick grid near the (simulated) mark, inside the 10% band.
  const mark = (await long.getByTestId('perp-mark').innerText()).trim();
  const [whole, frac = ''] = mark.split('.');
  const price = `${whole}.${frac.padEnd(2, '0').slice(0, 2)}`;

  await short.getByRole('button', { name: 'Sell / Short' }).click();
  await short.fill('#price', price);
  await short.fill('#quantity', '1');
  await short.getByTestId('order-form').locator('button[type=submit]').click();
  await expect(short.getByText('Order submitted.')).toBeVisible();

  await long.fill('#price', price);
  await long.fill('#quantity', '1');
  await expect(long.getByTestId('margin-required')).not.toHaveText('—');
  await long.getByTestId('order-form').locator('button[type=submit]').click();

  const row = long.getByTestId('position-row');
  await expect(row).toContainText('long 10x');
  await expect(row).toContainText(price.replace(/\.?0+$/, ''));
  await expect(short.getByTestId('position-row')).toContainText('short 10x');
});
