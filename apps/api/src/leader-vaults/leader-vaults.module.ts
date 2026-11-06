import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { LedgerModule } from '../ledger/ledger.module';
import { LeaderVaultsController } from './leader-vaults.controller';
import { LeaderVaultsService } from './leader-vaults.service';

/** Vault ticks (snapshots, drawdown halt, queued redemptions) on the perp risk cadence ×60. */
@Injectable()
export class LeaderVaultsScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(
    private readonly vaults: LeaderVaultsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const ms = this.config.PERP_RISK_POLL_MS;
    if (ms <= 0) return;
    this.timer = setInterval(() => void this.tick(), ms * 60);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.vaults.tick();
    } finally {
      this.running = false;
    }
  }
}

@Global()
@Module({
  imports: [LedgerModule],
  controllers: [LeaderVaultsController],
  providers: [LeaderVaultsService, LeaderVaultsScheduler],
  exports: [LeaderVaultsService],
})
export class LeaderVaultsModule {}
