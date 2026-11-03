import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { loadAppConfig } from '../src/config/app-config';
import { MailService, type MailMessage } from '../src/mail/mail.service';

export async function bootApp(): Promise<INestApplication> {
  if (!process.env.TEST_LOGS) Logger.overrideLogger(false); // TEST_LOGS=1 shows server logs
  const app = await createApp(loadAppConfig());
  await app.init();
  return app;
}

/**
 * A browser-like client: keeps cookies, fetches a CSRF token, and uses a
 * unique client IP (via X-Forwarded-For, trusted for one hop) so rate limits
 * are isolated per test client.
 */
export class TestClient {
  readonly agent: ReturnType<typeof request.agent>;
  readonly ip = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  private csrfToken: string | null = null;

  constructor(private readonly app: INestApplication) {
    this.agent = request.agent(app.getHttpServer());
  }

  async csrf(): Promise<string> {
    if (!this.csrfToken) {
      const res = await this.agent.get('/v1/auth/csrf').set('X-Forwarded-For', this.ip).expect(200);
      this.csrfToken = (res.body as { csrfToken: string }).csrfToken;
    }
    return this.csrfToken;
  }

  get(path: string) {
    return this.agent.get(path).set('X-Forwarded-For', this.ip);
  }

  async post(path: string, body?: object) {
    const token = await this.csrf();
    return this.agent
      .post(path)
      .set('X-Forwarded-For', this.ip)
      .set('X-CSRF-Token', token)
      .send(body ?? {});
  }

  async patch(path: string, body?: object) {
    const token = await this.csrf();
    return this.agent
      .patch(path)
      .set('X-Forwarded-For', this.ip)
      .set('X-CSRF-Token', token)
      .send(body ?? {});
  }

  async delete(path: string) {
    const token = await this.csrf();
    return this.agent.delete(path).set('X-Forwarded-For', this.ip).set('X-CSRF-Token', token);
  }
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@test.invalid`;
}

export const PASSWORD = 'a perfectly long passphrase 42';

export function mails(app: INestApplication): readonly MailMessage[] {
  return app.get(MailService).sentMessages();
}

export function lastMailTo(
  app: INestApplication,
  email: string,
  kind: MailMessage['kind'],
): MailMessage {
  const found = [...mails(app)].reverse().find((m) => m.to === email && m.kind === kind);
  if (!found) throw new Error(`No ${kind} mail sent to ${email}`);
  return found;
}

export function tokenFromMail(mail: MailMessage): string {
  const match = /#token=([A-Za-z0-9_-]+)/.exec(mail.text);
  if (!match?.[1]) throw new Error('No token link in mail');
  return match[1];
}

/** Registers and verifies a user, returning a logged-in client. */
export async function createVerifiedUser(
  app: INestApplication,
  email = uniqueEmail(),
): Promise<TestClient> {
  const client = new TestClient(app);
  await (
    await client.post('/v1/auth/register', { email, password: PASSWORD, acceptTerms: true })
  ).body;
  const token = tokenFromMail(lastMailTo(app, email, 'email_verification'));
  const verify = await client.post('/v1/auth/verify-email', { token });
  if (verify.status !== 200) throw new Error(`verify failed: ${verify.status}`);
  const login = await client.post('/v1/auth/login', { email, password: PASSWORD });
  if (login.status !== 200)
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return client;
}
