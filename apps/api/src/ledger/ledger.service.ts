import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  Prisma,
  type ActorType,
  type Asset,
  type JournalEntry,
  type LedgerAccount,
  type LedgerAccountType,
  type PostingDirection,
} from '@prisma/client';
import {
  formatAmount,
  formatAmountTrimmed,
  parseAmount,
  type AssetDto,
  type BalanceDto,
  type LedgerHistoryItemDto,
} from '@platform/shared';
import { randomUUID } from 'node:crypto';
import { AuditService, type AuditEvent } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import {
  ACCOUNT_SPECS,
  assertBalancedPerAsset,
  balanceDelta,
  fingerprintOf,
  mirrorPostings,
  toMinorUnits,
  validateEntryRequest,
  type EntryRequest,
  type PostingRequest,
} from './ledger-domain';

export interface LedgerActor {
  actorType: ActorType;
  actorUserId?: string | null;
  requestId?: string | null;
}

export interface TransactionalAccounts {
  id(assetId: string, type: LedgerAccountType, ownerUserId: string | null): Promise<string>;
  /** Call only after the transaction committed. */
  commit(): void;
}

export interface PostOptions {
  audit?: Omit<AuditEvent, 'actorType' | 'actorUserId'>;
  metadata?: Record<string, unknown>;
}

export interface PostResult {
  entry: JournalEntry;
  /** True when an identical request with the same idempotency key was already posted. */
  replayed: boolean;
}

interface LockedAccountRow {
  id: string;
  asset_id: string;
  normal_side: PostingDirection;
  allow_negative: boolean;
  balance: string;
}

const SYSTEM_OWNER = 'system';

function insufficientFunds(): AppError {
  return new AppError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'INSUFFICIENT_FUNDS',
    'Insufficient available balance',
  );
}

function prismaErrorText(err: unknown): string {
  if (err instanceof Error) {
    const meta = (err as { meta?: unknown }).meta;
    return `${err.message} ${meta ? JSON.stringify(meta) : ''}`;
  }
  return String(err);
}

function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.includes(column);
  return typeof target === 'string' && target.includes(column);
}

/**
 * The double-entry ledger (ADR-0006). This service is the only writer of
 * journal entries. All amounts are bigint minor units.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ assets

  async createAsset(
    input: { code: string; name: string; scale: number; paper?: boolean; faucetAmount?: string },
    actor: LedgerActor,
  ): Promise<Asset> {
    const paper = input.paper ?? false;
    let faucet: bigint | null = null;
    if (paper !== (input.faucetAmount !== undefined)) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        'Paper assets need a faucetAmount; real assets must not have one',
      );
    }
    if (input.faucetAmount !== undefined) {
      try {
        faucet = parseAmount(input.faucetAmount, input.scale);
      } catch (err) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', (err as Error).message);
      }
      if (faucet <= 0n)
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'VALIDATION_FAILED',
          'faucetAmount must be positive',
        );
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const asset = await tx.asset.create({
          data: {
            code: input.code,
            name: input.name,
            scale: input.scale,
            isPaper: paper,
            faucetAmount: faucet === null ? null : faucet.toString(),
          },
        });
        await this.audit.record(
          {
            action: 'ledger.asset.created',
            outcome: 'SUCCESS',
            actorType: actor.actorType,
            actorUserId: actor.actorUserId ?? null,
            targetType: 'asset',
            targetId: asset.code,
            context: { requestId: actor.requestId ?? null },
            metadata: { name: asset.name, scale: asset.scale },
          },
          tx,
        );
        return asset;
      });
    } catch (err) {
      if (isUniqueViolationOn(err, 'code')) {
        throw new AppError(
          HttpStatus.CONFLICT,
          'CONFLICT',
          'An asset with this code already exists',
        );
      }
      throw err;
    }
  }

  async setAssetStatus(
    code: string,
    status: 'ACTIVE' | 'DISABLED',
    actor: LedgerActor,
  ): Promise<Asset> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.asset.findUnique({ where: { code } });
      if (!existing) throw AppError.notFound('Asset not found');
      const asset = await tx.asset.update({ where: { code }, data: { status } });
      await this.audit.record(
        {
          action: 'ledger.asset.status_changed',
          outcome: 'SUCCESS',
          actorType: actor.actorType,
          actorUserId: actor.actorUserId ?? null,
          targetType: 'asset',
          targetId: code,
          context: { requestId: actor.requestId ?? null },
          metadata: { from: existing.status, to: status },
        },
        tx,
      );
      return asset;
    });
  }

  listAssets(onlyActive: boolean): Promise<Asset[]> {
    return this.prisma.asset.findMany({
      where: onlyActive ? { status: 'ACTIVE' } : {},
      orderBy: { code: 'asc' },
    });
  }

  toAssetDto(asset: Asset): AssetDto {
    return {
      code: asset.code,
      name: asset.name,
      scale: asset.scale,
      status: asset.status,
      paper: asset.isPaper,
      faucetAmount:
        asset.faucetAmount === null
          ? null
          : formatAmountTrimmed(toMinorUnits(asset.faucetAmount), asset.scale),
    };
  }

  async requireAsset(code: string, mustBeActive = true): Promise<Asset> {
    const asset = await this.prisma.asset.findUnique({ where: { code } });
    if (!asset) throw AppError.notFound(`Unknown asset ${code}`);
    if (mustBeActive && asset.status !== 'ACTIVE') {
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', `Asset ${code} is disabled`);
    }
    return asset;
  }

  // ---------------------------------------------------------------- accounts

  /** Returns the account, creating it (with zero balance) if needed. Race-safe. */
  async ensureAccount(
    assetId: string,
    type: LedgerAccountType,
    ownerUserId: string | null,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<LedgerAccount> {
    const spec = ACCOUNT_SPECS[type];
    if (spec.userOwned !== (ownerUserId !== null)) {
      throw new Error(
        `Account type ${type} ${spec.userOwned ? 'requires' : 'must not have'} an owner`,
      );
    }
    const ownerKey = ownerUserId ?? SYSTEM_OWNER;
    await client.$executeRaw`
      INSERT INTO "ledger_accounts" ("id", "asset_id", "type", "owner_user_id", "owner_key", "normal_side", "allow_negative", "updated_at")
      VALUES (${randomUUID()}::uuid, ${assetId}::uuid, ${type}::"LedgerAccountType", ${ownerUserId}::uuid, ${ownerKey},
              ${spec.normalSide}::"PostingDirection", ${spec.allowNegative}, now())
      ON CONFLICT ("asset_id", "type", "owner_key") DO NOTHING`;
    return client.ledgerAccount.findUniqueOrThrow({
      where: { assetId_type_ownerKey: { assetId, type, ownerKey } },
    });
  }

  private readonly accountIdCache = new Map<string, string>();

  /**
   * Account id lookup with an in-process cache (hot path: order entry and
   * settlement). Safe because accounts are never deleted and their identity is
   * immutable (DB trigger). Creation always happens OUTSIDE any caller
   * transaction, so a cached id can never refer to a rolled-back row; an unused
   * empty account is harmless.
   */
  async accountId(
    assetId: string,
    type: LedgerAccountType,
    ownerUserId: string | null,
  ): Promise<string> {
    const key = `${assetId}:${type}:${ownerUserId ?? SYSTEM_OWNER}`;
    const cached = this.accountIdCache.get(key);
    if (cached) return cached;
    const account = await this.ensureAccount(assetId, type, ownerUserId);
    this.accountIdCache.set(key, account.id);
    return account.id;
  }

  /**
   * Account resolution for code running INSIDE a transaction. Never call
   * `accountId()` (which may use another pool connection) while holding a
   * transaction: under load that starved the pool and deadlocked order entry
   * against settlement (measured, Sprint 4). Missing accounts are created with
   * the same transaction client and enter the shared cache only after commit.
   */
  transactionalAccounts(tx: Prisma.TransactionClient): TransactionalAccounts {
    const pending = new Map<string, string>();
    return {
      id: async (assetId, type, ownerUserId) => {
        const key = `${assetId}:${type}:${ownerUserId ?? SYSTEM_OWNER}`;
        const hit = this.accountIdCache.get(key) ?? pending.get(key);
        if (hit) return hit;
        const account = await this.ensureAccount(assetId, type, ownerUserId, tx);
        pending.set(key, account.id);
        return account.id;
      },
      commit: () => {
        for (const [key, id] of pending) this.accountIdCache.set(key, id);
      },
    };
  }

  // ------------------------------------------------------------------ posting

  /**
   * Posts a balanced journal entry atomically (ADR-0006 posting algorithm).
   * Idempotent: replaying the same key with the same content returns the
   * original entry; the same key with different content is rejected.
   */
  async post(
    req: EntryRequest,
    actor: LedgerActor,
    options: PostOptions = {},
  ): Promise<PostResult> {
    const postings = validateEntryRequest(req);
    const fingerprint = fingerprintOf(req);

    const existing = await this.prisma.journalEntry.findUnique({
      where: { idempotencyKey: req.idempotencyKey },
    });
    if (existing) return this.replay(existing, fingerprint);

    try {
      const entry = await this.prisma.$transaction(
        (tx) => this.writeEntry(tx, req, postings, fingerprint, actor, options),
        { timeout: 15_000 },
      );
      return { entry, replayed: false };
    } catch (err) {
      if (isUniqueViolationOn(err, 'idempotency_key')) {
        // Lost a race with an identical request: resolve to the committed entry.
        const winner = await this.prisma.journalEntry.findUniqueOrThrow({
          where: { idempotencyKey: req.idempotencyKey },
        });
        return this.replay(winner, fingerprint);
      }
      throw this.mapPostError(err);
    }
  }

  /**
   * Posts inside a transaction owned by the caller (e.g. hold funds and enqueue
   * an engine command atomically). Replays are detected within the same
   * transaction; any failure aborts the caller's transaction.
   */
  async postWithin(
    tx: Prisma.TransactionClient,
    req: EntryRequest,
    actor: LedgerActor,
    options: PostOptions = {},
  ): Promise<PostResult> {
    const postings = validateEntryRequest(req);
    const fingerprint = fingerprintOf(req);
    const existing = await tx.journalEntry.findUnique({
      where: { idempotencyKey: req.idempotencyKey },
    });
    if (existing) return this.replay(existing, fingerprint);
    try {
      const entry = await this.writeEntry(tx, req, postings, fingerprint, actor, options);
      return { entry, replayed: false };
    } catch (err) {
      throw this.mapPostError(err);
    }
  }

  /**
   * Posts many entries inside the caller's transaction with a constant number
   * of round trips (settlement hot path). Same guarantees as `postWithin` for
   * every entry: validation, per-asset balance, idempotency (replays return the
   * existing entry; fingerprint mismatch is rejected), non-negative pre-check
   * applied sequentially in request order, and all accounts locked in id order.
   * The database triggers still verify every posting and entry at commit.
   */
  async postBatchWithin(
    tx: Prisma.TransactionClient,
    requests: EntryRequest[],
    actor: LedgerActor,
  ): Promise<Map<string, JournalEntry>> {
    const result = new Map<string, JournalEntry>();
    if (requests.length === 0) return result;
    const prepared = requests.map((req) => ({
      req,
      postings: validateEntryRequest(req),
      fingerprint: fingerprintOf(req),
    }));
    const keys = prepared.map((p) => p.req.idempotencyKey);
    if (new Set(keys).size !== keys.length)
      throw new Error('Duplicate idempotency key within a ledger batch');

    const existing = await tx.journalEntry.findMany({ where: { idempotencyKey: { in: keys } } });
    for (const entry of existing) {
      const p = prepared.find((x) => x.req.idempotencyKey === entry.idempotencyKey)!;
      result.set(entry.idempotencyKey, this.replay(entry, p.fingerprint).entry);
    }
    const toWrite = prepared.filter((p) => !result.has(p.req.idempotencyKey));
    if (toWrite.length === 0) return result;

    const accountIds = [
      ...new Set(toWrite.flatMap((p) => p.postings.map((x) => x.accountId))),
    ].sort();
    const rows = await tx.$queryRaw<LockedAccountRow[]>`
      SELECT "id", "asset_id", "normal_side", "allow_negative", "balance"::text AS "balance"
        FROM "ledger_accounts"
       WHERE "id" = ANY(${accountIds}::uuid[])
       ORDER BY "id"
         FOR UPDATE`;
    if (rows.length !== accountIds.length) throw AppError.notFound('Ledger account not found');
    const byId = new Map(rows.map((r) => [r.id, r]));
    const balances = new Map(rows.map((r) => [r.id, toMinorUnits(r.balance)]));

    for (const p of toWrite) {
      assertBalancedPerAsset(
        p.postings.map((x) => ({ ...x, assetId: byId.get(x.accountId)!.asset_id })),
      );
      for (const x of p.postings) {
        const row = byId.get(x.accountId)!;
        const next =
          balances.get(x.accountId)! + balanceDelta(row.normal_side, x.direction, x.amount);
        if (!row.allow_negative && next < 0n) throw insufficientFunds();
        balances.set(x.accountId, next);
      }
    }

    try {
      const created = await tx.journalEntry.createManyAndReturn({
        data: toWrite.map((p) => ({
          type: p.req.type,
          idempotencyKey: p.req.idempotencyKey,
          fingerprint: p.fingerprint,
          description: p.req.description,
          reversesEntryId: p.req.reversesEntryId ?? null,
          actorType: actor.actorType,
          actorUserId: actor.actorUserId ?? null,
          requestId: actor.requestId ?? null,
        })),
      });
      const idByKey = new Map(created.map((e) => [e.idempotencyKey, e]));
      await tx.posting.createMany({
        data: toWrite.flatMap((p) =>
          p.postings.map((x) => ({
            entryId: idByKey.get(p.req.idempotencyKey)!.id,
            accountId: x.accountId,
            assetId: byId.get(x.accountId)!.asset_id,
            direction: x.direction,
            amount: x.amount.toString(),
          })),
        ),
      });
      for (const e of created) result.set(e.idempotencyKey, e);
      return result;
    } catch (err) {
      throw this.mapPostError(err);
    }
  }

  private mapPostError(err: unknown): unknown {
    if (isUniqueViolationOn(err, 'reverses_entry_id')) {
      return new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'This entry has already been reversed');
    }
    // Database backstop for non-negative balances (should be pre-empted by the pre-check).
    if (prismaErrorText(err).includes('ledger_accounts_non_negative_chk'))
      return insufficientFunds();
    return err;
  }

  private async writeEntry(
    tx: Prisma.TransactionClient,
    req: EntryRequest,
    postings: PostingRequest[],
    fingerprint: string,
    actor: LedgerActor,
    options: PostOptions,
  ): Promise<JournalEntry> {
    const accountIds = postings.map((p) => p.accountId);
    // Lock in id order: every writer uses the same order, so no deadlocks.
    const rows = await tx.$queryRaw<LockedAccountRow[]>`
      SELECT "id", "asset_id", "normal_side", "allow_negative", "balance"::text AS "balance"
        FROM "ledger_accounts"
       WHERE "id" = ANY(${accountIds}::uuid[])
       ORDER BY "id"
         FOR UPDATE`;
    if (rows.length !== accountIds.length) throw AppError.notFound('Ledger account not found');
    const byId = new Map(rows.map((r) => [r.id, r]));

    const withAssets = postings.map((p) => ({ ...p, assetId: byId.get(p.accountId)!.asset_id }));
    assertBalancedPerAsset(withAssets);

    for (const p of postings) {
      const row = byId.get(p.accountId)!;
      const next = toMinorUnits(row.balance) + balanceDelta(row.normal_side, p.direction, p.amount);
      if (!row.allow_negative && next < 0n) throw insufficientFunds();
    }

    const created = await tx.journalEntry.create({
      data: {
        type: req.type,
        idempotencyKey: req.idempotencyKey,
        fingerprint,
        description: req.description,
        reversesEntryId: req.reversesEntryId ?? null,
        actorType: actor.actorType,
        actorUserId: actor.actorUserId ?? null,
        requestId: actor.requestId ?? null,
        metadata: (options.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    await tx.posting.createMany({
      data: withAssets.map((p) => ({
        entryId: created.id,
        accountId: p.accountId,
        assetId: p.assetId,
        direction: p.direction,
        amount: p.amount.toString(),
      })),
    });
    if (options.audit) {
      await this.audit.record(
        {
          ...options.audit,
          actorType: actor.actorType,
          actorUserId: actor.actorUserId ?? null,
          metadata: { ...options.audit.metadata, entryId: created.id.toString() },
        },
        tx,
      );
    }
    return created;
  }

  private replay(entry: JournalEntry, fingerprint: string): PostResult {
    if (entry.fingerprint !== fingerprint) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key was already used for a different request',
      );
    }
    return { entry, replayed: true };
  }

  // ----------------------------------------------------- business operations

  private async userAccounts(userId: string, assetCode: string) {
    const asset = await this.requireAsset(assetCode);
    const available = await this.ensureAccount(asset.id, 'USER_AVAILABLE', userId);
    const locked = await this.ensureAccount(asset.id, 'USER_LOCKED', userId);
    return { asset, available, locked };
  }

  /** Moves funds from available to locked (e.g. for an open order). */
  async hold(
    params: {
      userId: string;
      assetCode: string;
      amount: bigint;
      idempotencyKey: string;
      description: string;
    },
    actor: LedgerActor,
  ): Promise<PostResult> {
    const { available, locked } = await this.userAccounts(params.userId, params.assetCode);
    return this.post(
      {
        type: 'BALANCE_HOLD',
        idempotencyKey: params.idempotencyKey,
        description: params.description,
        postings: [
          { accountId: available.id, direction: 'DEBIT', amount: params.amount },
          { accountId: locked.id, direction: 'CREDIT', amount: params.amount },
        ],
      },
      actor,
    );
  }

  /** Moves funds from locked back to available. */
  async release(
    params: {
      userId: string;
      assetCode: string;
      amount: bigint;
      idempotencyKey: string;
      description: string;
    },
    actor: LedgerActor,
  ): Promise<PostResult> {
    const { available, locked } = await this.userAccounts(params.userId, params.assetCode);
    return this.post(
      {
        type: 'BALANCE_RELEASE',
        idempotencyKey: params.idempotencyKey,
        description: params.description,
        postings: [
          { accountId: locked.id, direction: 'DEBIT', amount: params.amount },
          { accountId: available.id, direction: 'CREDIT', amount: params.amount },
        ],
      },
      actor,
    );
  }

  /**
   * DEVELOPMENT ONLY: credits a user with simulated funds. Refused outside
   * DEPLOY_ENV=local|ci so it can never mint balances in staging/production.
   */
  async simulatedDeposit(
    params: { userId: string; assetCode: string; amount: bigint; idempotencyKey: string },
    actor: LedgerActor,
  ): Promise<PostResult> {
    if (this.config.DEPLOY_ENV !== 'local' && this.config.DEPLOY_ENV !== 'ci') {
      throw AppError.forbidden(
        'Simulated deposits are only available in local and CI environments',
      );
    }
    const { asset, available } = await this.userAccounts(params.userId, params.assetCode);
    if (asset.isPaper) {
      throw new AppError(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'Paper assets are funded through the paper faucet',
      );
    }
    const custody = await this.ensureAccount(asset.id, 'SIMULATED_CUSTODY', null);
    return this.post(
      {
        type: 'SIMULATED_DEPOSIT',
        idempotencyKey: params.idempotencyKey,
        description: `Simulated deposit (development only) of ${formatAmount(params.amount, asset.scale)} ${asset.code}`,
        postings: [
          { accountId: custody.id, direction: 'DEBIT', amount: params.amount },
          { accountId: available.id, direction: 'CREDIT', amount: params.amount },
        ],
      },
      actor,
      {
        audit: {
          action: 'ledger.simulated_deposit',
          outcome: 'SUCCESS',
          targetType: 'user',
          targetId: params.userId,
          context: { requestId: actor.requestId ?? null },
          metadata: { asset: asset.code, amount: formatAmount(params.amount, asset.scale) },
        },
      },
    );
  }

  /**
   * Paper trading faucet (ADR-0010): grants the asset's configured amount of a
   * PAPER asset, at most once per user, asset and UTC day (enforced by the
   * idempotency key). Available in every environment because paper funds can
   * never touch real assets (database-enforced namespace isolation).
   */
  async paperFaucet(
    userId: string,
    assetCode: string,
    actor: LedgerActor,
    now = new Date(),
  ): Promise<PostResult> {
    const asset = await this.requireAsset(assetCode);
    if (!asset.isPaper || asset.faucetAmount === null) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        `${asset.code} is not a paper asset`,
      );
    }
    const day = now.toISOString().slice(0, 10);
    const key = `paper-faucet:${userId}:${asset.id}:${day}`;
    if (
      await this.prisma.journalEntry.findUnique({
        where: { idempotencyKey: key },
        select: { id: true },
      })
    ) {
      throw new AppError(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Paper faucet already used for this asset today (resets 00:00 UTC)',
      );
    }
    const amount = toMinorUnits(asset.faucetAmount);
    const faucet = await this.accountId(asset.id, 'PAPER_FAUCET', null);
    const available = await this.accountId(asset.id, 'USER_AVAILABLE', userId);
    const result = await this.post(
      {
        type: 'PAPER_FAUCET_GRANT',
        idempotencyKey: key,
        description: `Paper trading funds: ${formatAmount(amount, asset.scale)} ${asset.code} (simulated, no value)`,
        postings: [
          { accountId: faucet, direction: 'DEBIT', amount },
          { accountId: available, direction: 'CREDIT', amount },
        ],
      },
      actor,
      {
        audit: {
          action: 'paper.faucet.grant',
          outcome: 'SUCCESS',
          targetType: 'user',
          targetId: userId,
          context: { requestId: actor.requestId ?? null },
          metadata: { asset: asset.code, amount: formatAmount(amount, asset.scale) },
        },
      },
    );
    if (result.replayed) {
      throw new AppError(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Paper faucet already used for this asset today (resets 00:00 UTC)',
      );
    }
    return result;
  }

  /** Posts the mirror image of an entry. Each entry can be reversed once; reversals cannot be reversed. */
  async reverse(
    params: { entryId: bigint; reason: string; idempotencyKey: string },
    actor: LedgerActor,
  ): Promise<PostResult> {
    const original = await this.prisma.journalEntry.findUnique({
      where: { id: params.entryId },
      include: { postings: true },
    });
    if (!original) throw AppError.notFound('Journal entry not found');
    const existingReversal = await this.prisma.journalEntry.findUnique({
      where: { reversesEntryId: original.id },
      select: { id: true, idempotencyKey: true },
    });
    if (existingReversal && existingReversal.idempotencyKey !== params.idempotencyKey) {
      throw new AppError(HttpStatus.CONFLICT, 'CONFLICT', 'This entry has already been reversed');
    }
    if (original.type === 'REVERSAL') {
      throw new AppError(
        HttpStatus.CONFLICT,
        'CONFLICT',
        'Reversal entries cannot be reversed; post a new entry',
      );
    }
    const postings: PostingRequest[] = original.postings.map((p) => ({
      accountId: p.accountId,
      direction: p.direction,
      amount: toMinorUnits(p.amount),
    }));
    return this.post(
      {
        type: 'REVERSAL',
        idempotencyKey: params.idempotencyKey,
        description: `Reversal of entry ${original.id}: ${params.reason}`.slice(0, 256),
        reversesEntryId: original.id,
        postings: mirrorPostings(postings),
      },
      actor,
      {
        audit: {
          action: 'ledger.entry.reversed',
          outcome: 'SUCCESS',
          targetType: 'journal_entry',
          targetId: original.id.toString(),
          context: { requestId: actor.requestId ?? null },
          metadata: { reason: params.reason },
        },
      },
    );
  }

  // ---------------------------------------------------------------- queries

  /** Balances for every active asset (zero if the user has no account yet). */
  async balancesForUser(userId: string): Promise<BalanceDto[]> {
    const [assets, accounts] = await Promise.all([
      this.prisma.asset.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.ledgerAccount.findMany({ where: { ownerUserId: userId } }),
    ]);
    const result: BalanceDto[] = [];
    for (const asset of assets) {
      const mine = accounts.filter((a) => a.assetId === asset.id);
      const available = toMinorUnits(mine.find((a) => a.type === 'USER_AVAILABLE')?.balance ?? '0');
      const locked = toMinorUnits(mine.find((a) => a.type === 'USER_LOCKED')?.balance ?? '0');
      const margin = toMinorUnits(mine.find((a) => a.type === 'USER_MARGIN')?.balance ?? '0');
      if (asset.status !== 'ACTIVE' && available === 0n && locked === 0n && margin === 0n) continue;
      result.push({
        asset: asset.code,
        name: asset.name,
        scale: asset.scale,
        paper: asset.isPaper,
        available: formatAmount(available, asset.scale),
        locked: formatAmount(locked, asset.scale),
        margin: formatAmount(margin, asset.scale),
        total: formatAmount(available + locked + margin, asset.scale),
      });
    }
    return result;
  }

  async historyForUser(
    userId: string,
    query: { limit: number; before?: string },
  ): Promise<{ items: LedgerHistoryItemDto[]; nextBefore: string | null }> {
    const postings = await this.prisma.posting.findMany({
      where: {
        account: { ownerUserId: userId },
        ...(query.before ? { id: { lt: BigInt(query.before) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit,
      include: { entry: { select: { type: true } }, account: true, asset: true },
    });
    const items = postings.map((p) => {
      const delta = balanceDelta(p.account.normalSide, p.direction, toMinorUnits(p.amount));
      const formatted = formatAmount(delta < 0n ? -delta : delta, p.asset.scale);
      return {
        postingId: p.id.toString(),
        entryId: p.entryId.toString(),
        entryType: p.entry.type,
        asset: p.asset.code,
        bucket:
          p.account.type === 'USER_LOCKED'
            ? ('locked' as const)
            : p.account.type === 'USER_MARGIN'
              ? ('margin' as const)
              : ('available' as const),
        change: `${delta < 0n ? '-' : '+'}${formatted}`,
        createdAt: p.createdAt.toISOString(),
      };
    });
    return {
      items,
      nextBefore:
        postings.length === query.limit
          ? (postings[postings.length - 1]?.id.toString() ?? null)
          : null,
    };
  }

  async entryWithPostings(entryId: bigint) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: { postings: { include: { asset: true, account: true }, orderBy: { id: 'asc' } } },
    });
    if (!entry) throw AppError.notFound('Journal entry not found');
    return {
      id: entry.id.toString(),
      type: entry.type,
      idempotencyKey: entry.idempotencyKey,
      description: entry.description,
      reversesEntryId: entry.reversesEntryId?.toString() ?? null,
      actorType: entry.actorType,
      actorUserId: entry.actorUserId,
      requestId: entry.requestId,
      createdAt: entry.createdAt.toISOString(),
      postings: entry.postings.map((p) => ({
        id: p.id.toString(),
        accountId: p.accountId,
        accountType: p.account.type,
        ownerUserId: p.account.ownerUserId,
        asset: p.asset.code,
        direction: p.direction,
        amount: formatAmount(toMinorUnits(p.amount), p.asset.scale),
      })),
    };
  }

  async accountsFor(ownerUserId: string | undefined) {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: ownerUserId ? { ownerUserId } : { ownerKey: SYSTEM_OWNER },
      include: { asset: true },
      orderBy: [{ assetId: 'asc' }, { type: 'asc' }],
      take: 500,
    });
    return accounts.map((a) => ({
      id: a.id,
      asset: a.asset.code,
      type: a.type,
      ownerUserId: a.ownerUserId,
      normalSide: a.normalSide,
      balance: formatAmount(toMinorUnits(a.balance), a.asset.scale),
      updatedAt: a.updatedAt.toISOString(),
    }));
  }
}
