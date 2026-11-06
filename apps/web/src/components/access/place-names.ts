/** Display names for jurisdictions on the restricted list (ADR-0023). */

// ISO 3166-2 subdivisions have no Intl display names; these are the ones the
// suggested preset uses. Unknown codes are shown as the code itself.
const SUBDIVISIONS: Record<string, string> = {
  'CA-ON': 'Ontario (Canada)',
  'UA-43': 'Crimea (Ukraine)',
  'UA-40': 'Sevastopol (Ukraine)',
  'UA-14': 'Donetsk region (Ukraine)',
  'UA-09': 'Luhansk region (Ukraine)',
};

let regions: Intl.DisplayNames | null = null;

export function countryName(code: string): string {
  try {
    regions ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}

export function subdivisionName(code: string): string {
  return SUBDIVISIONS[code] ?? code;
}

export function locationName(country: string | null, subdivision: string | null): string | null {
  if (!country) return null;
  if (!subdivision) return countryName(country);
  return SUBDIVISIONS[subdivision] ?? `${countryName(country)} (${subdivision})`;
}
