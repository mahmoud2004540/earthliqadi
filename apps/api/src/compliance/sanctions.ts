import type { KycSubmitInput } from '@platform/shared';

export type ScreeningOutcome = 'clear' | 'hit' | 'not_screened';

/**
 * Sanctions/PEP screening provider boundary (ADR-0012). No provider is
 * integrated or claimed: that requires a contract and legal review. Until
 * then every case is "not_screened", and approval of unscreened cases is
 * refused outside local/ci.
 */
export interface SanctionsScreener {
  readonly name: string;
  screen(profile: KycSubmitInput): Promise<ScreeningOutcome>;
}

export class NotConfiguredScreener implements SanctionsScreener {
  readonly name = 'none (no provider configured)';
  screen(): Promise<ScreeningOutcome> {
    return Promise.resolve('not_screened');
  }
}

export const SANCTIONS_SCREENER = Symbol('SANCTIONS_SCREENER');
