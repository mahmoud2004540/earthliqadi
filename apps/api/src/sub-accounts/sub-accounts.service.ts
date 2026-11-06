import { HttpStatus, Injectable } from '@nestjs/common';
import { parseAmount, type SubAccountDto } from '@platform/shared';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { RequestContext } from '../common/request-context';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { RbacService } from '../rbac/rbac.service';

const MAX_SUB_ACCOUNTS = 10;

/**
 * Sub-accounts (ADR-0017): separate balances, orders and positions under one
 * wallet. They have no credentials; the parent's session or API keys act as
 * them with the `X-Sub-Account` header. Funds move only between the parent
 * and its own sub-accounts, so everything stays in the parent wallet's leaf
 * of the vault state.
 */
@Injectable()
export class SubAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  async list(parentId: string): Promise<SubAccountDto[]> {
    const rows = await this.prisma.user.findMany({
      where: { parentUserId: parentId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      label: r.label ?? '',
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async create(parentId: string, label: string, ctx: RequestContext): Promise<SubAccountDto> {
    const parent = await this.prisma.user.findUniqueOrThrow({ where: { id: parentId } });
    if (!parent.walletAddress || parent.parentUserId)
      throw AppError.forbidden('Sub-accounts belong to a wallet account');
    if ((await this.prisma.user.count({ where: { parentUserId: parentId } })) >= MAX_SUB_ACCOUNTS)
      throw new AppError(
        HttpStatus.CONFLICT,
        'LIMIT_EXCEEDED',
        `At most ${MAX_SUB_ACCOUNTS} sub-accounts per account`,
      );
    const sub = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { parentUserId: parentId, label, status: 'ACTIVE' },
      });
      await this.rbac.assignDefaultRole(created.id, tx);
      await this.audit.record(
        {
          action: 'account.sub_account.created',
          outcome: 'SUCCESS',
          actorType: 'USER',
          actorUserId: parentId,
          targetType: 'user',
          targetId: created.id,
          context: ctx,
          metadata: { label },
        },
        tx,
      );
      return created;
    });
    return { id: sub.id, label, createdAt: sub.createdAt.toISOString() };
  }

  /** The sub-account if it belongs to this parent and is active; otherwise 404. */
  async requireOwned(parentId: string, subId: string) {
    const sub = await this.prisma.user.findFirst({
      where: { id: subId, parentUserId: parentId, status: 'ACTIVE' },
    });
    if (!sub) throw AppError.notFound('Sub-account not found');
    return sub;
  }

  /** Moves available funds between the parent and one of its sub-accounts (or two of them). */
  async transfer(
    parentId: string,
    input: { from: string; to: string; asset: string; amount: string; idempotencyKey: string },
    ctx: RequestContext,
  ): Promise<{ entryId: string; replayed: boolean }> {
    const resolve = async (ref: string) =>
      ref === 'main' ? parentId : (await this.requireOwned(parentId, ref)).id;
    const from = await resolve(input.from);
    const to = await resolve(input.to);
    const asset = await this.ledger.requireAsset(input.asset);
    let amount: bigint;
    try {
      amount = parseAmount(input.amount, asset.scale);
    } catch (err) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', (err as Error).message);
    }
    if (amount <= 0n)
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Amount must be positive');
    const src = await this.ledger.accountId(asset.id, 'USER_AVAILABLE', from);
    const dst = await this.ledger.accountId(asset.id, 'USER_AVAILABLE', to);
    const { entry, replayed } = await this.ledger.post(
      {
        type: 'INTERNAL_TRANSFER',
        idempotencyKey: `subxfer:${parentId}:${input.idempotencyKey}`,
        description: `Transfer between own accounts: ${input.amount} ${asset.code}`,
        postings: [
          { accountId: src, direction: 'DEBIT', amount },
          { accountId: dst, direction: 'CREDIT', amount },
        ],
      },
      { actorType: 'USER', actorUserId: parentId, requestId: ctx.requestId },
      {
        audit: {
          action: 'account.sub_account.transfer',
          outcome: 'SUCCESS',
          targetType: 'user',
          targetId: to,
          context: ctx,
          metadata: { from, to, asset: asset.code, amount: input.amount },
        },
      },
    );
    return { entryId: entry.id.toString(), replayed };
  }
}
