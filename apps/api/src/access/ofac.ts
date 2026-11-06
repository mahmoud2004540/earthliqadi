/**
 * OFAC SDN list parsing (ADR-0023). OFAC publishes sanctioned wallet
 * addresses inside the remarks of SDN entries, as
 * "Digital Currency Address - <TICKER> <address>". Every 0x address with 40
 * hex digits is an EVM account whatever ticker it is listed under (ETH, USDT,
 * USDC, BNB, ETC, ...), so all of them are screened here. Other chains'
 * formats (Bitcoin, Tron, ...) cannot sign in here and are skipped.
 */

export const OFAC_SOURCE = 'ofac-sdn';

const DIGITAL_CURRENCY =
  /Digital Currency Address - [A-Za-z0-9]+\s+(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g;

/** Unique lower-case EVM addresses listed in an SDN.CSV (or sdn.xml) export. */
export function parseOfacSdnAddresses(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(DIGITAL_CURRENCY)) out.add(m[1]!.toLowerCase());
  return [...out].sort();
}

/**
 * Refuses an update that looks like a broken download: an empty result, or
 * one that drops more than half of the currently loaded addresses. Official
 * lists grow over time; a sudden large removal needs an operator (`--force`).
 */
export function checkListUpdate(current: number, next: number): string | null {
  if (next === 0) return 'the downloaded list contains no EVM addresses';
  if (current > 0 && next < current / 2)
    return `the downloaded list has ${next} addresses, less than half of the ${current} loaded`;
  return null;
}
