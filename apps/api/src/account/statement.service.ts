import { Injectable } from '@nestjs/common';
import type { StatementDto } from '@platform/shared';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { csvField, periodBounds, signed } from './statement';

const MAX_LINES = 10_000;

/**
 * Account statements (ADR-0028), built from the double-entry ledger: per
 * asset, the opening and closing totals and every entry that changed the
 * account's total across all its buckets. Holds and margin moves inside the
 * account net to zero and are left out.
 */
@Injectable()
export class StatementService {
  constructor(private readonly prisma: PrismaService) {}

  async statement(userId: string, period: string): Promise<StatementDto> {
    const { from, to } = periodBounds(period);
    const delta = `CASE WHEN p."direction" = a."normal_side" THEN p."amount" ELSE -p."amount" END`;
    const opening = await this.prisma.$queryRawUnsafe<{ asset_id: string; total: string }[]>(
      `SELECT p."asset_id", SUM(${delta})::text AS "total"
         FROM "postings" p JOIN "ledger_accounts" a ON a."id" = p."account_id"
        WHERE a."owner_user_id" = $1::uuid AND p."created_at" < $2
        GROUP BY p."asset_id"`,
      userId,
      from,
    );
    const perEntry = `
      SELECT p."entry_id", p."asset_id", SUM(${delta}) AS "net"
        FROM "postings" p JOIN "ledger_accounts" a ON a."id" = p."account_id"
       WHERE a."owner_user_id" = $1::uuid AND p."created_at" >= $2 AND p."created_at" < $3
       GROUP BY p."entry_id", p."asset_id"
      HAVING SUM(${delta}) <> 0`;
    const totals = await this.prisma.$queryRawUnsafe<
      { asset_id: string; credits: string; debits: string }[]
    >(
      `SELECT "asset_id", SUM(GREATEST("net", 0))::text AS "credits", SUM(LEAST("net", 0))::text AS "debits"
         FROM (${perEntry}) x GROUP BY "asset_id"`,
      userId,
      from,
      to,
    );
    const rows = await this.prisma.$queryRawUnsafe<
      {
        entry_id: bigint;
        asset_id: string;
        net: string;
        time: Date;
        type: string;
        description: string;
      }[]
    >(
      `SELECT x."entry_id", x."asset_id", x."net"::text AS "net", e."created_at" AS "time",
              e."type"::text AS "type", e."description"
         FROM (${perEntry}) x JOIN "journal_entries" e ON e."id" = x."entry_id"
        ORDER BY x."entry_id", x."asset_id"
        LIMIT ${MAX_LINES + 1}`,
      userId,
      from,
      to,
    );
    const assetIds = [...new Set([...opening, ...totals].map((r) => r.asset_id))];
    const assets = await this.prisma.asset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true, code: true, scale: true },
    });
    const byId = new Map(assets.map((a) => [a.id, a]));
    const out: StatementDto['assets'] = [];
    for (const a of [...assets].sort((x, y) => x.code.localeCompare(y.code))) {
      const open = BigInt(opening.find((r) => r.asset_id === a.id)?.total ?? '0');
      const t = totals.find((r) => r.asset_id === a.id);
      const credits = BigInt(t?.credits ?? '0');
      const debits = BigInt(t?.debits ?? '0');
      const closing = open + credits + debits;
      if (open === 0n && credits === 0n && debits === 0n) continue;
      out.push({
        asset: a.code,
        opening: signed(open, a.scale),
        credits: signed(credits, a.scale),
        debits: signed(debits, a.scale),
        closing: signed(closing, a.scale),
      });
    }
    return {
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      generatedAt: new Date().toISOString(),
      assets: out,
      lines: rows.slice(0, MAX_LINES).map((r) => {
        const a = byId.get(r.asset_id)!;
        return {
          time: r.time.toISOString(),
          entryId: r.entry_id.toString(),
          type: r.type,
          description: r.description,
          asset: a.code,
          change: signed(BigInt(r.net), a.scale, true),
        };
      }),
      truncated: rows.length > MAX_LINES,
    };
  }

  /** The statement as CSV: a summary block, then the lines. */
  toCsv(s: StatementDto): string {
    const out: string[] = [];
    out.push(
      ['Statement', s.period, `from ${s.from}`, `to ${s.to}`, `generated ${s.generatedAt}`]
        .map((v) => csvField(v))
        .join(','),
    );
    out.push(
      ['Not a bank statement. Balances are not bank deposits and have no deposit insurance.']
        .map((v) => csvField(v))
        .join(','),
    );
    out.push('');
    out.push(
      ['asset', 'opening', 'credits', 'debits', 'closing'].map((v) => csvField(v)).join(','),
    );
    for (const a of s.assets)
      out.push(
        [a.asset, a.opening, a.credits, a.debits, a.closing].map((v) => csvField(v)).join(','),
      );
    out.push('');
    out.push(
      ['time_utc', 'entry_id', 'type', 'description', 'asset', 'change']
        .map((v) => csvField(v))
        .join(','),
    );
    for (const l of s.lines)
      out.push(
        [
          csvField(l.time),
          csvField(l.entryId),
          csvField(l.type),
          csvField(l.description, true),
          csvField(l.asset),
          csvField(l.change),
        ].join(','),
      );
    if (s.truncated)
      out.push(csvField('Truncated: request a shorter period for every line.', true));
    return `${out.join('\r\n')}\r\n`;
  }
}
