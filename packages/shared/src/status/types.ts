import { z } from 'zod';

/** Public status page and incidents (ADR-0030). */
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const INCIDENT_IMPACTS = ['minor', 'major', 'critical'] as const;

export const createIncidentSchema = z.object({
  title: z.string().trim().min(5).max(160),
  impact: z.enum(INCIDENT_IMPACTS),
  body: z.string().trim().min(10).max(2000),
});

export const incidentUpdateSchema = z.object({
  status: z.enum(INCIDENT_STATUSES),
  body: z.string().trim().min(10).max(2000),
});

export type ComponentState = 'operational' | 'degraded' | 'outage';

export interface StatusComponentDto {
  key: 'trading' | 'vault' | 'chain' | 'sanctions';
  state: ComponentState;
  /** Plain-language detail, e.g. "2 of 5 markets delayed". */
  detail: string;
  /** When the underlying signal was last seen (null if never). */
  lastSeen: string | null;
}

export interface IncidentDto {
  id: string;
  title: string;
  impact: (typeof INCIDENT_IMPACTS)[number];
  status: (typeof INCIDENT_STATUSES)[number];
  startedAt: string;
  resolvedAt: string | null;
  updates: { status: (typeof INCIDENT_STATUSES)[number]; body: string; at: string }[];
}

export interface StatusDto {
  generatedAt: string;
  overall: ComponentState;
  components: StatusComponentDto[];
  /** Open incidents first, then those resolved in the last 90 days. */
  incidents: IncidentDto[];
}
