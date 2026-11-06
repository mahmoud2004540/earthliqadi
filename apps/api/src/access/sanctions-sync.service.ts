import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AccessService } from './access.service';
import { OFAC_SOURCE, checkListUpdate, parseOfacSdnAddresses } from './ofac';

const MAX_BYTES = 64 * 1024 * 1024;

export interface SyncResult {
  source: string;
  added: number;
  removed: number;
  total: number;
}

/**
 * Downloads OFAC's SDN list every SANCTIONS_SYNC_HOURS and replaces the
 * `ofac-sdn` source (ADR-0023). A failed or suspicious download keeps the
 * previous list: screening never silently turns off.
 */
@Injectable()
export class SanctionsSyncService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SanctionsSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly access: AccessService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const hours = this.config.SANCTIONS_SYNC_HOURS;
    if (hours <= 0) return;
    // First run shortly after boot, then on the interval.
    const first = setTimeout(() => void this.tick(), 10_000);
    first.unref();
    this.timer = setInterval(() => void this.tick(), hours * 3_600_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.syncOfac();
      this.logger.log(r, 'SANCTIONS_LIST_SYNCED');
    } catch (err) {
      // Alertable: the previous list stays in force.
      this.logger.error({ err }, 'SANCTIONS_SYNC_FAILED');
    } finally {
      this.running = false;
    }
  }

  /** Downloads the official list (or uses `text`, e.g. a file) and replaces the OFAC source. */
  async syncOfac(opts: { text?: string; force?: boolean } = {}): Promise<SyncResult> {
    const text = opts.text ?? (await this.download(this.config.SANCTIONS_OFAC_URL));
    const addresses = parseOfacSdnAddresses(text);
    const current =
      (await this.access.sanctionsSummary()).find((s) => s.source === OFAC_SOURCE)?.addresses ?? 0;
    const problem = checkListUpdate(current, addresses.length);
    if (problem && !(opts.force && addresses.length > 0))
      throw new Error(`refusing to update ${OFAC_SOURCE}: ${problem}`);
    const r = await this.access.replaceSanctionsList(OFAC_SOURCE, addresses);
    return { source: OFAC_SOURCE, ...r };
  }

  private async download(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    if (!res.url.startsWith('https://')) throw new Error('download was redirected off https');
    const body = await res.arrayBuffer();
    if (body.byteLength > MAX_BYTES) throw new Error('download is unexpectedly large');
    return new TextDecoder('utf-8').decode(body);
  }
}
