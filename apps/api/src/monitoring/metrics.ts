/**
 * Minimal Prometheus registry (text exposition format 0.0.4), no dependency.
 * In-process counters and histograms; gauges are computed at scrape time.
 */
type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map(
      (k) =>
        `${k}="${labels[k]!.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
    )
    .join(',');
}

export class Counter {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

export class Histogram {
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[],
  ) {}
  observe(labels: Labels, value: number): void {
    const k = key(labels);
    const s = this.series.get(k) ?? { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
    this.bounds.forEach((b, i) => {
      if (value <= b) s.buckets[i]!++;
    });
    s.sum += value;
    s.count++;
    this.series.set(k, s);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      this.bounds.forEach((b, i) =>
        lines.push(`${this.name}_bucket{${sep}le="${b}"} ${s.buckets[i]}`),
      );
      lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export function gauge(
  name: string,
  help: string,
  samples: { labels?: Labels; value: number }[],
): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const s of samples) {
    const k = key(s.labels ?? {});
    lines.push(`${name}${k ? `{${k}}` : ''} ${Number.isFinite(s.value) ? s.value : 'NaN'}`);
  }
  return lines.join('\n');
}

/** Process-wide instruments, incremented by the API's workers and HTTP layer. */
export const metrics = {
  httpRequests: new Counter(
    'exchange_http_requests_total',
    'HTTP requests by method, route and status class',
  ),
  httpDuration: new Histogram(
    'exchange_http_request_duration_seconds',
    'HTTP request duration',
    [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  ),
  settlementFailures: new Counter(
    'exchange_settlement_failures_total',
    'Settlement passes that failed (SETTLEMENT_HALTED)',
  ),
  riskTickFailures: new Counter(
    'exchange_perp_risk_tick_failures_total',
    'Failed perpetual risk ticks',
  ),
};
