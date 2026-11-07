import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { StatusService } from '../src/status/status.service';
import { TestClient, bootApp } from './helpers';
import { EngineProcess } from './engine';
import { TradingFixture } from './trading-helpers';

/** Public status page and incident reports (ADR-0030). */
let app: INestApplication;
let prisma: PrismaService;
let status: StatusService;
const ctx = { requestId: 'test', ipAddress: null, userAgent: null };

beforeAll(async () => {
  app = await bootApp();
  prisma = app.get(PrismaService);
  status = app.get(StatusService);
}, 60_000);
afterAll(async () => {
  await app.close();
});

describe('status page', () => {
  it('is public, derives components from live signals and lists incidents', async () => {
    const res = await new TestClient(app).get('/v1/status');
    expect(res.status).toBe(200);
    expect(res.body.components.map((c: { key: string }) => c.key)).toContain('trading');
    expect(['operational', 'degraded', 'outage']).toContain(res.body.overall);

    const fx = new TradingFixture(app, new EngineProcess());
    const staff = await fx.trader();
    // Staff-only and step-up protected over HTTP.
    expect(
      (await staff.client.post('/v1/admin/incidents', { title: 'x', impact: 'minor', body: 'y' }))
        .status,
    ).toBe(403);

    const inc = await status.create(
      staff.userId,
      {
        title: 'Delayed withdrawals',
        impact: 'critical',
        body: 'We are investigating slow withdrawal signing.',
      },
      ctx,
    );
    expect(inc).toMatchObject({ status: 'investigating', resolvedAt: null });
    let pub = (await new TestClient(app).get('/v1/status')).body;
    expect(pub.overall).toBe('outage'); // an open critical incident
    expect(pub.incidents[0]).toMatchObject({ id: inc.id, title: 'Delayed withdrawals' });

    await status.addUpdate(
      staff.userId,
      inc.id,
      { status: 'identified', body: 'The signer queue stalled; restarting it.' },
      ctx,
    );
    const done = await status.addUpdate(
      staff.userId,
      inc.id,
      { status: 'resolved', body: 'Withdrawals are signing normally again.' },
      ctx,
    );
    expect(done.resolvedAt).not.toBeNull();
    expect(done.updates.map((u) => u.status)).toEqual(['resolved', 'identified', 'investigating']);
    await expect(
      status.addUpdate(
        staff.userId,
        inc.id,
        { status: 'monitoring', body: 'Too late to reopen it.' },
        ctx,
      ),
    ).rejects.toThrow(/resolved/);
    pub = (await new TestClient(app).get('/v1/status')).body;
    expect(pub.incidents.find((i: { id: string }) => i.id === inc.id).status).toBe('resolved');

    // Published updates cannot be edited or deleted.
    await expect(
      prisma.incidentUpdate.updateMany({
        where: { incidentId: inc.id },
        data: { body: 'rewritten history' },
      }),
    ).rejects.toThrow(/append-only/);
    expect(
      await prisma.auditLog.count({
        where: { targetId: inc.id, action: { startsWith: 'status.incident' } },
      }),
    ).toBe(3);
  });
});
