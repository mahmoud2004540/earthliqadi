import type { INestApplication } from '@nestjs/common';
import { parseAmount } from '@platform/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import WebSocket from 'ws';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { MarketsService } from '../src/trading/markets.service';
import { SettlementService } from '../src/trading/settlement.service';
import type { EngineProcess } from './engine';
import { PASSWORD, TestClient, createVerifiedUser, uniqueEmail } from './helpers';

export const SYSTEM = { actorType: 'SYSTEM' as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Trader {
  client: TestClient;
  userId: string;
  email: string;
}

/** Trading fixtures shared by integration suites that run the real engine. */
export class TradingFixture {
  readonly prisma: PrismaService;
  readonly ledger: LedgerService;
  readonly settlement: SettlementService;

  constructor(
    readonly app: INestApplication,
    readonly engine: EngineProcess,
  ) {
    this.prisma = app.get(PrismaService);
    this.ledger = app.get(LedgerService);
    this.settlement = app.get(SettlementService);
  }

  /** BASE (scale 8) / QUOTE (scale 6), tick 0.01, lot 0.0001. */
  async market(fees = { makerFeeBps: 0, takerFeeBps: 0 }) {
    const code = () => `T${randomBytes(4).toString('hex').toUpperCase()}`;
    const base = code();
    const quote = code();
    await this.ledger.createAsset({ code: base, name: `Base ${base}`, scale: 8 }, SYSTEM);
    await this.ledger.createAsset({ code: quote, name: `Quote ${quote}`, scale: 6 }, SYSTEM);
    const m = await this.app
      .get(MarketsService)
      .create({ base, quote, tickSize: '0.01', lotSize: '0.0001', ...fees }, SYSTEM);
    return { symbol: m.symbol, base, quote, id: m.id };
  }

  async trader(funds: { asset: string; amount: string; scale: number }[] = []): Promise<Trader> {
    const email = uniqueEmail('trader');
    const client = await createVerifiedUser(this.app, email);
    const { id: userId } = await this.prisma.user.findUniqueOrThrow({ where: { email } });
    for (const f of funds) {
      await this.ledger.simulatedDeposit(
        {
          userId,
          assetCode: f.asset,
          amount: parseAmount(f.amount, f.scale),
          idempotencyKey: `dep:${randomUUID()}`,
        },
        SYSTEM,
      );
    }
    return { client, userId, email };
  }

  place(t: Trader, body: Record<string, unknown>) {
    return t.client.post('/v1/orders', { clientOrderId: randomUUID(), ...body });
  }

  async status(orderId: string): Promise<string> {
    return (await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  }

  /** Drives settlement until the predicate holds (the engine runs asynchronously). */
  async until(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.settlement.processPending();
      if (await predicate()) return;
      if (Date.now() > deadline) {
        throw new Error(
          `condition not met in time. Engine logs:\n${this.engine.logs.slice(-10).join('\n')}`,
        );
      }
      await sleep(25);
    }
  }
}

/** Fresh login returning the raw session cookie (for WebSocket upgrades). */
export async function sessionCookie(app: INestApplication, email: string): Promise<string> {
  const agent = request.agent(app.getHttpServer());
  const ip = `10.250.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
  const csrf = (await agent.get('/v1/auth/csrf').set('X-Forwarded-For', ip)).body
    .csrfToken as string;
  const res = await agent
    .post('/v1/auth/login')
    .set('X-Forwarded-For', ip)
    .set('X-CSRF-Token', csrf)
    .send({ email, password: PASSWORD });
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('session='),
  );
  if (!cookie) throw new Error('no session cookie');
  return cookie.split(';')[0]!;
}

export function portOf(app: INestApplication): number {
  return (app.getHttpServer().address() as AddressInfo).port;
}

/** Minimal test WebSocket client that buffers messages and waits for matches. */
export class WsClient {
  readonly messages: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.messages.push(
        JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Record<string, unknown>,
      );
      this.waiters.splice(0).forEach((w) => w());
    });
    socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  static connect(
    port: number,
    opts: {
      origin?: string | null;
      cookie?: string;
      ip?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: {
          ...(opts.origin === null ? {} : { Origin: opts.origin ?? 'http://localhost:3000' }),
          'X-Forwarded-For': opts.ip ?? `10.251.${randomBytes(1)[0]}.${randomBytes(1)[0]}`,
          ...(opts.cookie ? { Cookie: opts.cookie } : {}),
          ...(opts.headers ?? {}),
        },
      });
      socket.once('open', () => resolve(new WsClient(socket)));
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
      socket.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves with the first buffered or future message matching the predicate. */
  async next(
    predicate: (m: Record<string, unknown>) => boolean,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) {
        this.messages.splice(this.messages.indexOf(found), 1);
        return found;
      }
      if (this.closed) throw new Error(`socket closed (${this.closed.code} ${this.closed.reason})`);
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(`no matching message; got: ${JSON.stringify(this.messages).slice(0, 800)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}
