import { freshness, overallState, tradingState, worst } from './status-rules';

describe('status rules', () => {
  it('summarises trading from market states', () => {
    expect(tradingState([])).toEqual({ state: 'operational', detail: 'No markets listed' });
    expect(tradingState(['live', 'live'])).toEqual({
      state: 'operational',
      detail: '2 of 2 markets live',
    });
    expect(tradingState(['live', 'delayed', 'halted'])).toEqual({
      state: 'degraded',
      detail: '1 halted, 1 delayed of 3 markets',
    });
    expect(tradingState(['halted', 'halted']).state).toBe('outage');
  });
  it('degrades stale or missing periodic signals', () => {
    const now = new Date('2026-11-07T12:00:00Z');
    expect(freshness(new Date('2026-11-07T11:59:00Z'), 120_000, now)).toBe('operational');
    expect(freshness(new Date('2026-11-07T11:50:00Z'), 120_000, now)).toBe('degraded');
    expect(freshness(null, 120_000, now)).toBe('degraded');
  });
  it('takes the worst component, raised by open major or critical incidents', () => {
    expect(worst(['operational', 'degraded'])).toBe('degraded');
    expect(overallState(['operational'], ['minor'])).toBe('operational');
    expect(overallState(['operational'], ['major'])).toBe('degraded');
    expect(overallState(['degraded'], ['critical'])).toBe('outage');
  });
});
