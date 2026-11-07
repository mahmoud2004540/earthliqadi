import { formatAmountTrimmed } from '@platform/shared';

/** UTC bounds of "YYYY" or "YYYY-MM" (end exclusive). */
export function periodBounds(period: string): { from: Date; to: Date } {
  const [y, m] = period.split('-').map(Number) as [number, number | undefined];
  if (m === undefined)
    return { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)) };
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

/** Signed decimal with an explicit sign for changes ("+1.5", "-0.25", "0"). */
export function signed(minor: bigint, scale: number, plus = false): string {
  if (minor === 0n) return '0';
  const s = formatAmountTrimmed(minor < 0n ? -minor : minor, scale);
  return minor < 0n ? `-${s}` : plus ? `+${s}` : s;
}

/**
 * One CSV field. Quotes everything and neutralises spreadsheet formulas in
 * text fields (a leading = + - @ tab or CR gets a leading apostrophe).
 */
export function csvField(v: string, text = false): string {
  const safe = text && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}
