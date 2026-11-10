import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Injectable,
  Module,
  VERSION_NEUTRAL,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { finalize, type Observable } from 'rxjs';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ChainModule } from '../chain/chain.module';
import { ChainService } from '../chain/chain.service';
import { HealthReportService } from '../approvals/health-report.service';
import { AppError } from '../common/app-error';
import { Public } from '../common/decorators';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { gauge, metrics } from './metrics';

/** Records count and duration per route template (never raw paths: bounded cardinality). */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const started = process.hrtime.bigint();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      finalize(() => {
        const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
        const labels = {
          method: req.method,
          route,
          status: `${Math.floor(res.statusCode / 100)}xx`,
        };
        metrics.httpRequests.inc(labels);
        metrics.httpDuration.observe(
          { method: req.method, route },
          Number(process.hrtime.bigint() - started) / 1e9,
        );
      }),
    );
  }
}

/**
 * Prometheus scrape endpoint. Disabled unless METRICS_TOKEN is set; requires
 * `Authorization: Bearer <token>`. The edge proxy does not route it publicly.
 */
@ApiExcludeController()
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(
    private readonly health: HealthReportService,
    private readonly chain: ChainService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private authorise(header: string | undefined): void {
    const token = this.config.METRICS_TOKEN;
    if (!token) throw AppError.notFound('Not found');
    const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '', 'utf8');
    const expected = Buffer.from(token, 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw AppError.unauthenticated();
  }

  @Public()
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(@Headers('authorization') authorization?: string): Promise<string> {
    this.authorise(authorization);
    const h = await this.health.report();
    const mem = process.memoryUsage();
    // Vault liveness (ADR-0038). A failed read is itself reported, never hidden.
    let vault: Awaited<ReturnType<ChainService['vaultHealth']>> = null;
    let vaultReadOk = true;
    if (this.chain.enabled) {
      try {
        vault = await this.chain.vaultHealth();
      } catch {
        vaultReadOk = false;
      }
    }
    const parts = [
      gauge('exchange_process_uptime_seconds', 'Process uptime', [{ value: process.uptime() }]),
      gauge('exchange_process_heap_used_bytes', 'V8 heap used', [{ value: mem.heapUsed }]),
      metrics.httpRequests.render(),
      metrics.httpDuration.render(),
      metrics.settlementFailures.render(),
      metrics.riskTickFailures.render(),
      metrics.chainFailures.render(),
      gauge(
        'exchange_engine_backlog_commands',
        'Commands enqueued but not yet processed by the engine',
        h.markets.map((m) => ({ labels: { market: m.symbol }, value: Number(m.engineBacklog) })),
      ),
      gauge(
        'exchange_settlement_lag_events',
        'Engine events not yet settled',
        h.markets.map((m) => ({ labels: { market: m.symbol }, value: Number(m.settlementLag) })),
      ),
      gauge(
        'exchange_market_halted',
        '1 if the market is halted',
        h.markets.map((m) => ({
          labels: { market: m.symbol },
          value: m.status === 'HALTED' ? 1 : 0,
        })),
      ),
      gauge(
        'exchange_perp_index_stale',
        '1 if a perpetual market has no reliable index/mark price',
        h.markets
          .filter((m) => m.indexStale !== null)
          .map((m) => ({ labels: { market: m.symbol }, value: m.indexStale ? 1 : 0 })),
      ),
      gauge(
        'exchange_reconciliation_ok',
        '1 if the latest ledger reconciliation found no discrepancy',
        h.reconciliation ? [{ value: h.reconciliation.status === 'OK' ? 1 : 0 }] : [],
      ),
      gauge(
        'exchange_reconciliation_age_seconds',
        'Seconds since the latest reconciliation started',
        h.reconciliation
          ? [{ value: (Date.now() - Date.parse(h.reconciliation.startedAt)) / 1000 }]
          : [],
      ),
      gauge(
        'exchange_insurance_fund_balance',
        'Insurance fund balance in asset units (monitoring only; the ledger is authoritative)',
        h.insuranceFunds.map((f) => ({ labels: { asset: f.asset }, value: Number(f.balance) })),
      ),
      gauge('exchange_positions_liquidating', 'Positions currently being liquidated', [
        { value: h.positionsLiquidating },
      ]),
      gauge('exchange_approvals_pending', 'Maker-checker requests awaiting a decision', [
        { value: h.queues.approvalsPending },
      ]),
      gauge('exchange_kyc_cases_pending', 'Identity verification cases awaiting review', [
        { value: h.queues.kycPending },
      ]),
      gauge('exchange_support_tickets_open', 'Support tickets not closed', [
        { value: h.queues.ticketsOpen },
      ]),
      gauge(
        'exchange_vault_read_ok',
        '1 if the vault state could be read from the chain',
        this.chain.enabled ? [{ value: vaultReadOk ? 1 : 0 }] : [],
      ),
      ...(vault
        ? [
            gauge(
              'exchange_vault_commit_age_seconds',
              'Seconds since the last on-chain state commit',
              [{ value: vault.commitAgeSeconds }],
            ),
            gauge(
              'exchange_vault_freeze_delay_seconds',
              'Silence after which anyone may freeze the vault',
              [{ value: vault.freezeDelaySeconds }],
            ),
            gauge('exchange_vault_frozen', '1 if the vault is frozen (escape hatch active)', [
              { value: vault.frozen ? 1 : 0 },
            ]),
            gauge('exchange_vault_operator_gas_eth', 'ETH held by the vault operator for gas', [
              { value: vault.operatorGasEth },
            ]),
            gauge('exchange_chain_indexer_lag_blocks', 'Chain head minus the indexed block', [
              { value: vault.indexerLagBlocks },
            ]),
          ]
        : []),
    ];
    return `${parts.join('\n')}\n`;
  }
}

@Module({
  imports: [ApprovalsModule, ChainModule],
  controllers: [MetricsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor }],
})
export class MonitoringModule {}
