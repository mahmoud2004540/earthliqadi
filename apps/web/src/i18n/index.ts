import { en, type Dictionary } from './en';

/**
 * The web app is English-only (ADR-0008). Copy lives in one typed dictionary
 * so wording is reviewable in one place and can be localised later if needed.
 */
export type { Dictionary };

export function getDictionary(): Dictionary {
  return en;
}
