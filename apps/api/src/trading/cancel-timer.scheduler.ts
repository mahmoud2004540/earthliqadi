import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { OrdersService } from './orders.service';

/** Fires expired dead-man switches every CANCEL_TIMER_POLL_MS (ADR-0017). */
@Injectable()
export class CancelTimerScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CancelTimerScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly orders: OrdersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const ms = this.config.CANCEL_TIMER_POLL_MS;
    if (ms <= 0) return;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const fired = await this.orders.fireCancelTimers();
      if (fired > 0) this.logger.warn({ fired }, 'CANCEL_AFTER_FIRED');
    } catch (err) {
      this.logger.error({ err }, 'cancel-after check failed');
    } finally {
      this.running = false;
    }
  }
}
