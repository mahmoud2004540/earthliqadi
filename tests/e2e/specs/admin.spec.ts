import { expect, request, test, type Browser, type Page } from '@playwright/test';
import { PASSWORD, cli, totp, uniqueEmail, verificationLink } from '../stack';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

async function signUp(browser: Browser, tag: string): Promise<Page> {
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
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard');
  return page;
}

/** A staff member with roles and TOTP MFA, signed in; the session is handed to a browser. */
async function staff(browser: Browser, roles: string[]): Promise<Page> {
  const api = await request.newContext({ baseURL: BASE_URL });
  const email = uniqueEmail('e2e-staff');
  const csrf = ((await (await api.get('/api/v1/auth/csrf')).json()) as { csrfToken: string })
    .csrfToken;
  const headers = { 'X-CSRF-Token': csrf };
  await api.post('/api/v1/auth/register', {
    headers,
    data: { email, password: PASSWORD, acceptTerms: true },
  });
  await expect
    .poll(() => {
      try {
        return verificationLink(email);
      } catch {
        return '';
      }
    })
    .not.toBe('');
  await api.post('/api/v1/auth/verify-email', {
    headers,
    data: { token: verificationLink(email).split('#token=')[1] },
  });
  for (const role of roles)
    cli('dist/cli/grant-role.js', '--email', email, '--role', role, '--reason', 'e2e staff');
  expect(
    (await api.post('/api/v1/auth/login', { headers, data: { email, password: PASSWORD } })).ok(),
  ).toBe(true);
  const setup = await api.post('/api/v1/me/mfa/totp/setup', {
    headers,
    data: { password: PASSWORD },
  });
  const { secret } = (await setup.json()) as { secret: string };
  expect(
    (await api.post('/api/v1/me/mfa/totp/enable', { headers, data: { code: totp(secret) } })).ok(),
  ).toBe(true);
  const context = await browser.newContext({ storageState: await api.storageState() });
  await api.dispose();
  return context.newPage();
}

test('support conversation through the admin console; KYC is switched off', async ({ browser }) => {
  const user = await signUp(browser, 'e2e-support');
  await expect(user.getByRole('tab', { name: 'Verification' })).toHaveCount(0);
  await user.getByRole('tab', { name: 'Support' }).click();
  await user.fill('#ticket-subject', 'Question about withdrawals');
  await user.fill('#ticket-body', 'How long does a vault withdrawal take?');
  await user.getByRole('button', { name: 'Open ticket' }).click();
  await expect(user.getByTestId('ticket-message')).toHaveCount(1);

  const agent = await staff(browser, ['support_agent', 'compliance_officer']);
  await agent.goto('/admin');
  await expect(agent.getByTestId('admin-console')).toBeVisible();
  await agent.getByRole('tab', { name: 'Verification' }).click();
  await expect(agent.getByText('Identity verification is not enabled')).toBeVisible();
  await agent.getByRole('tab', { name: 'Support' }).click();
  await agent
    .getByRole('button', { name: /Question about withdrawals/ })
    .last()
    .click();
  await agent.getByLabel('Reply').fill('Once per asset per UTC day.');
  await agent.getByRole('button', { name: 'Reply' }).click();
  await expect(agent.getByText('Once per asset per UTC day.')).toBeVisible();

  await user.reload();
  await user.getByRole('tab', { name: 'Inbox' }).click();
  await expect(
    user.getByTestId('notification').filter({ hasText: 'Support replied to your ticket' }),
  ).toBeVisible();
});

test('customers cannot use the admin console', async ({ browser }) => {
  const user = await signUp(browser, 'e2e-noadmin');
  await expect(user.getByTestId('admin-link')).toHaveCount(0);
  await user.goto('/admin');
  await expect(user.getByText('You do not have staff permissions.')).toBeVisible();
});
