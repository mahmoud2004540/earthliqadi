import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const COMPOSE_FILE = resolve(__dirname, '../../docker-compose.yml');
export const PASSWORD = 'correct horse battery staple 1';

/** Runs a command in a Compose service (used for dev-only CLIs and reading the dev mail log). */
export function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024, // API logs grow quickly; the default 1 MB overflowed (ENOBUFS)
  });
}

export function cli(...args: string[]): string {
  return compose('exec', '-T', 'api', 'node', ...args);
}

/** Latest verification link sent to `email` by the development mail transport. */
export function verificationLink(email: string): string {
  // Only the recent tail: mails for this run were sent seconds ago.
  const logs = compose('logs', '--no-log-prefix', '--tail', '3000', 'api');
  const pattern = new RegExp(
    `to=${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(https?://[^\\s"]+/verify-email#token=[A-Za-z0-9_-]+)`,
    'g',
  );
  const matches = [...logs.matchAll(pattern)];
  const link = matches.at(-1)?.[1];
  if (!link) throw new Error(`No verification link for ${email}`);
  return link;
}

export function uniqueEmail(tag: string): string {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}
