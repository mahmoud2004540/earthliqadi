import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { GrowthController } from './growth.controller';
import { GrowthService } from './growth.service';

/** Recomputes fee tiers and points every GROWTH_JOB_INTERVAL_SECONDS (0 disables). */
@Injectable()
export class GrowthScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(GrowthScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly growth: GrowthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const s = this.config.GROWTH_JOB_INTERVAL_SECONDS;
    if (s <= 0) return;
    this.timer = setInterval(() => void this.tick(), s * 1000);
    this.timer.unref();
    void this.tick();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.growth.recompute();
      this.logger.log(r, 'Fee tiers and points recomputed');
    } catch (err) {
      this.logger.error({ err }, 'Growth recomputation failed');
    } finally {
      this.running = false;
    }
  }
}

@Module({
  controllers: [GrowthController],
  providers: [GrowthService, GrowthScheduler],
  exports: [GrowthService],
})
export class GrowthModule {}
