import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  wsClientMessageSchema,
  type CandleInterval,
  type WsChannel,
  type WsServerMessage,
} from '@platform/shared';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { cookieNames } from '../auth/cookies';
import { SessionService } from '../auth/session.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { OrdersService } from '../trading/orders.service';
import { MarketDataService } from './market-data.service';

export const WS_PATH = '/ws';
/** Gateway limits (ADR-0009). Mutable only so tests can shorten timings. */
export const WS_LIMITS = {
  maxConnectionsPerIp: 10,
  maxSubscriptions: 50,
  maxMessagesPerSecond: 20,
  heartbeatMs: 20_000,
  sessionRecheckMs: 30_000,
};

interface Subscription {
  channel: WsChannel;
  market: string;
  interval?: CandleInterval;
  /** Last settlement seq sent for this subscription. */
  seq: bigint;
  /** Last trade seq sent (trades channel). */
  tradeSeq?: bigint;
  /** Last order update time sent (orders channel). */
  ordersSince?: Date;
  /** Last freshness state sent (book/ticker), so staleness is pushed even when seq is stuck. */
  state?: string;
}

interface Client {
  socket: WebSocket;
  ip: string;
  userId: string | null;
  sessionToken: string | null;
  sessionCheckedAt: number;
  alive: boolean;
  subscriptions: Map<string, Subscription>;
  windowStart: number;
  messagesInWindow: number;
}

function rawToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * WebSocket gateway for market data and private order updates (ADR-0009).
 * Snapshots are pushed whenever a market's settlement sequence advances.
 */
@Injectable()
export class MarketDataGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MarketDataGateway.name);
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<Client>();
  private readonly perIp = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private server: Server | null = null;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) =>
    void this.handleUpgrade(req, socket, head);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly marketData: MarketDataService,
    private readonly sessions: SessionService,
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    // CLI tools boot an application context without an HTTP server: no WebSockets then.
    const adapter = this.adapterHost.httpAdapter as { getHttpServer(): unknown } | null | undefined;
    if (!adapter) return;
    this.server = adapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    this.server.on('upgrade', this.onUpgrade);
    if (this.config.MARKET_DATA_POLL_MS > 0) {
      this.pollTimer = setInterval(() => void this.poll(), this.config.MARKET_DATA_POLL_MS);
      this.pollTimer.unref();
    }
    this.heartbeatTimer = setInterval(() => this.heartbeat(), WS_LIMITS.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.server?.off('upgrade', this.onUpgrade);
    for (const c of this.clients) c.socket.terminate();
    this.wss?.close();
  }

  connectionCount(): number {
    return this.clients.size;
  }

  // ------------------------------------------------------------ connections

  private clientIp(req: IncomingMessage): string {
    // Same trust model as Express (`trust proxy` hops): take the hop-th address from the right.
    const hops = this.config.TRUST_PROXY_HOPS;
    const forwarded =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',').map((s) => s.trim()) ?? [];
    const chain = [...forwarded, req.socket.remoteAddress ?? 'unknown'];
    return chain[Math.max(0, chain.length - 1 - hops)] ?? 'unknown';
  }

  private reject(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH || !this.wss) return; // not ours (other upgrade handlers may exist)
    if (req.headers.origin !== new URL(this.config.WEB_ORIGIN).origin) {
      return this.reject(socket, 403, 'Forbidden');
    }
    const ip = this.clientIp(req);
    if ((this.perIp.get(ip) ?? 0) >= WS_LIMITS.maxConnectionsPerIp)
      return this.reject(socket, 429, 'Too Many Requests');

    const token = parseCookies(req.headers.cookie)[cookieNames(this.config).session] ?? null;
    let userId: string | null = null;
    if (token) {
      try {
        userId = (await this.sessions.validate(token))?.user.id ?? null;
      } catch (err) {
        this.logger.warn({ err }, 'Session validation failed during WebSocket upgrade');
      }
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = {
        socket: ws,
        ip,
        userId,
        sessionToken: userId ? token : null,
        sessionCheckedAt: Date.now(),
        alive: true,
        subscriptions: new Map(),
        windowStart: Date.now(),
        messagesInWindow: 0,
      };
      this.clients.add(client);
      this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
      ws.on('pong', () => {
        client.alive = true;
      });
      ws.on('message', (data) => void this.onMessage(client, data));
      ws.on('close', () => this.drop(client));
      ws.on('error', () => this.drop(client));
    });
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client)) return;
    const n = (this.perIp.get(client.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(client.ip);
    else this.perIp.set(client.ip, n);
  }

  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.socket.terminate();
        this.drop(c);
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }

  private send(client: Client, message: WsServerMessage): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(message));
    }
  }

  private error(client: Client, code: string, message: string): void {
    this.send(client, { type: 'error', code, message });
  }

  // --------------------------------------------------------------- messages

  private async onMessage(client: Client, data: RawData): Promise<void> {
    const now = Date.now();
    if (now - client.windowStart >= 1000) {
      client.windowStart = now;
      client.messagesInWindow = 0;
    }
    if (++client.messagesInWindow > WS_LIMITS.maxMessagesPerSecond) {
      this.error(client, 'RATE_LIMITED', 'Too many messages');
      client.socket.close(1008, 'rate limited');
      return;
    }

    let parsed;
    try {
      parsed = wsClientMessageSchema.safeParse(JSON.parse(rawToText(data)));
    } catch {
      return this.error(client, 'VALIDATION_FAILED', 'Messages must be JSON');
    }
    if (!parsed.success) return this.error(client, 'VALIDATION_FAILED', 'Invalid message');
    const msg = parsed.data;
    if (msg.op === 'ping') return this.send(client, { type: 'pong' });

    const key = `${msg.channel}:${msg.market}:${msg.interval ?? ''}`;
    if (msg.op === 'unsubscribe') {
      client.subscriptions.delete(key);
      return this.send(client, { type: 'unsubscribed', channel: msg.channel, market: msg.market });
    }

    if (msg.channel === 'orders' && !client.userId) {
      return this.error(client, 'UNAUTHENTICATED', 'Sign in to subscribe to private channels');
    }
    if (msg.channel === 'candles' && !msg.interval) {
      return this.error(client, 'VALIDATION_FAILED', 'candles requires an interval');
    }
    if (!client.subscriptions.has(key) && client.subscriptions.size >= WS_LIMITS.maxSubscriptions) {
      return this.error(
        client,
        'LIMIT_EXCEEDED',
        `At most ${WS_LIMITS.maxSubscriptions} subscriptions per connection`,
      );
    }
    const market = await this.prisma.market.findUnique({ where: { symbol: msg.market } });
    if (!market) return this.error(client, 'NOT_FOUND', `Unknown market ${msg.market}`);

    const sub: Subscription = {
      channel: msg.channel,
      market: msg.market,
      interval: msg.interval,
      seq: -1n,
    };
    client.subscriptions.set(key, sub);
    this.send(client, {
      type: 'subscribed',
      channel: msg.channel,
      market: msg.market,
      interval: msg.interval,
    });
    try {
      await this.push(client, sub, market.id, true);
    } catch (err) {
      this.logger.error({ err }, 'Failed to send WebSocket snapshot');
      this.error(client, 'INTERNAL_ERROR', 'Snapshot unavailable');
    }
  }

  // ---------------------------------------------------------------- pushes

  /** Sends a snapshot (or incremental trades/orders) for one subscription. */
  private async push(
    client: Client,
    sub: Subscription,
    marketId: string,
    initial: boolean,
  ): Promise<void> {
    switch (sub.channel) {
      case 'book': {
        const book = await this.marketData.book(sub.market, 50);
        sub.seq = BigInt(book.seq);
        sub.state = book.status.state;
        return this.send(client, { type: 'book', data: book });
      }
      case 'ticker': {
        const ticker = await this.marketData.ticker(sub.market);
        sub.seq = BigInt(ticker.seq);
        sub.state = ticker.status.state;
        return this.send(client, { type: 'ticker', data: ticker });
      }
      case 'candles': {
        const candles = await this.marketData.candles(sub.market, sub.interval ?? '1m', 300);
        sub.seq = BigInt(candles.seq);
        return this.send(client, {
          type: 'candles',
          market: sub.market,
          interval: sub.interval ?? '1m',
          seq: candles.seq,
          data: candles.data,
        });
      }
      case 'trades': {
        // The poller can run while the initial snapshot is still loading.
        // Without a cursor it would resend history as "new" trades.
        if (!initial && sub.tradeSeq === undefined) return;
        const trades = initial
          ? await this.marketData.trades(sub.market, 50)
          : await this.marketData.trades(sub.market, 200, sub.tradeSeq);
        if (trades[0]) sub.tradeSeq = BigInt(trades[0].seq);
        else if (initial) sub.tradeSeq = 0n;
        if (initial || trades.length > 0) {
          this.send(client, {
            type: 'trades',
            market: sub.market,
            snapshot: initial,
            data: trades,
          });
        }
        return;
      }
      case 'orders': {
        if (!client.userId) return;
        const since = sub.ordersSince;
        sub.ordersSince = new Date();
        const orders = await this.prisma.order.findMany({
          where: {
            userId: client.userId,
            marketId,
            ...(since && !initial ? { updatedAt: { gte: since } } : {}),
          },
          include: { market: { include: { baseAsset: true, quoteAsset: true } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        });
        if (initial || orders.length > 0) {
          this.send(client, {
            type: 'orders',
            market: sub.market,
            data: orders.map((o) => this.orders.toDto(o)),
          });
        }
        return;
      }
    }
  }

  /** Detects advanced settlement sequences and pushes updates to subscribers. */
  async poll(): Promise<void> {
    if (this.polling || this.clients.size === 0) return;
    this.polling = true;
    try {
      const sequences = await this.marketData.sequences();
      const markets = await this.prisma.market.findMany({
        select: { id: true, symbol: true, status: true },
      });
      const idBySymbol = new Map(markets.map((m) => [m.symbol, m.id]));
      const states = new Map<string, string>(); // freshness per market, computed lazily once per poll
      const stateOf = async (symbol: string): Promise<string> => {
        const cached = states.get(symbol);
        if (cached) return cached;
        const market = markets.find((m) => m.symbol === symbol)!;
        const state = (await this.marketData.status(this.prisma, market)).state;
        states.set(symbol, state);
        return state;
      };
      const now = Date.now();
      for (const client of [...this.clients]) {
        if (client.userId && now - client.sessionCheckedAt > WS_LIMITS.sessionRecheckMs) {
          client.sessionCheckedAt = now;
          const valid = client.sessionToken
            ? await this.sessions.validate(client.sessionToken)
            : null;
          if (!valid) {
            this.error(client, 'UNAUTHENTICATED', 'Session ended');
            client.socket.close(4401, 'session ended');
            this.drop(client);
            continue;
          }
        }
        for (const sub of client.subscriptions.values()) {
          const marketId = idBySymbol.get(sub.market);
          if (!marketId) continue;
          const seq = sequences.get(marketId) ?? 0n;
          const freshnessChanged =
            (sub.channel === 'book' || sub.channel === 'ticker') &&
            (await stateOf(sub.market)) !== sub.state;
          if (seq !== sub.seq || freshnessChanged) {
            await this.push(client, sub, marketId, false);
            sub.seq = seq;
          }
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Market data poll failed');
    } finally {
      this.polling = false;
    }
  }
}
