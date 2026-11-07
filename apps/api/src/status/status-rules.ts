import type { ComponentState } from '@platform/shared';

const RANK: Record<ComponentState, number> = { operational: 0, degraded: 1, outage: 2 };

export function worst(states: ComponentState[]): ComponentState {
  return states.reduce<ComponentState>((w, s) => (RANK[s] > RANK[w] ? s : w), 'operational');
}

/** Trading: live markets are fine; delayed or halted ones degrade it; all halted is an outage. */
export function tradingState(states: ('live' | 'delayed' | 'halted')[]): {
  state: ComponentState;
  detail: string;
} {
  if (states.length === 0) return { state: 'operational', detail: 'No markets listed' };
  const halted = states.filter((s) => s === 'halted').length;
  const delayed = states.filter((s) => s === 'delayed').length;
  if (halted === states.length) return { state: 'outage', detail: 'All markets halted' };
  if (halted + delayed === 0)
    return { state: 'operational', detail: `${states.length} of ${states.length} markets live` };
  const parts = [halted ? `${halted} halted` : '', delayed ? `${delayed} delayed` : ''].filter(
    Boolean,
  );
  return { state: 'degraded', detail: `${parts.join(', ')} of ${states.length} markets` };
}

/** A periodic signal is degraded once it is older than `maxAgeMs` (or has never happened). */
export function freshness(
  lastSeen: Date | null,
  maxAgeMs: number,
  now = new Date(),
): ComponentState {
  if (lastSeen === null) return 'degraded';
  return now.getTime() - lastSeen.getTime() > maxAgeMs ? 'degraded' : 'operational';
}

/** Overall: the worst component, raised by open incidents (major → degraded, critical → outage). */
export function overallState(
  components: ComponentState[],
  openIncidentImpacts: ('minor' | 'major' | 'critical')[],
): ComponentState {
  const fromIncidents = openIncidentImpacts.map<ComponentState>((i) =>
    i === 'critical' ? 'outage' : i === 'major' ? 'degraded' : 'operational',
  );
  return worst([...components, ...fromIncidents]);
}
