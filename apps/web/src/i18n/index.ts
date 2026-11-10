import { en, type Dictionary } from './en';
import { withRealFunds } from './real-funds';

/**
 * The web app is English-only (ADR-0008). Copy lives in one typed dictionary
 * so wording is reviewable in one place and can be localised later if needed.
 */
export type { Dictionary };

const real = process.env.NEXT_PUBLIC_REAL_FUNDS === 'true' ? withRealFunds(en) : en;

/** The copy for this build: testnet wording, or real-funds wording (ADR-0038). */
export function getDictionary(): Dictionary {
  return real;
}
