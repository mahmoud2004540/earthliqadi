import type { Dictionary } from './en';

/**
 * Wording for a real-funds launch (ADR-0038), switched on at build time with
 * NEXT_PUBLIC_REAL_FUNDS=true. Each entry replaces one exact testnet sentence
 * of `en`; a test fails if any of them no longer matches, so the two never
 * drift apart. Nothing here claims an audit, a licence or insurance.
 */
export const REAL_FUNDS_REPLACEMENTS: readonly (readonly [string, string])[] = [
  [
    'A security-first digital asset exchange in development. Pre-launch: no live trading and no customer funds.',
    'A non-custodial digital asset exchange. Funds are held in a smart contract that has not been independently audited.',
  ],
  [
    'Pre-launch development build. No real funds, no live trading and no regulated services are offered.',
    'Beta with real funds. The smart contract has not been independently audited and deposits are capped. Only deposit what you can afford to lose.',
  ],
  ['Pre-launch · Engineering preview', 'Beta · Unaudited smart contract'],
  ['Self-custody vault with escape hatch (testnet)', 'Self-custody vault with escape hatch'],
  [
    'The platform is in pre-launch development. It does not accept customer funds and does not offer trading or any regulated service.',
    'The platform is in beta with real funds. Its smart contract has not been independently audited; an internal review is published in the Trust Center. Deposits are capped in the contract.',
  ],
  [
    'Funds reach the exchange only through "Move to exchange", from your own wallet, on the network shown in Dashboard → Balances. The platform is currently a testnet beta: it accepts only test tokens, which have no value. Real funds are not accepted.',
    'Funds reach the exchange only through "Move to exchange", from your own wallet, on the network shown in Dashboard → Balances. The only accepted token is the one listed there. The smart contract has not been independently audited: only deposit what you can afford to lose.',
  ],
  [
    'Open Dashboard → Balances → Deposit → Transfer crypto. It shows your wallet address as text and as a QR code: send tokens there on the network shown, from an exchange or another wallet. On the testnet, press "Mint test tokens" instead, and get free test ETH for network fees from a public faucet. The page shows when tokens arrive.',
    'Open Dashboard → Balances → Deposit → Transfer crypto. It shows your wallet address as text and as a QR code: send the listed token there on the network shown, from an exchange or another wallet, and keep a little ETH on that network for fees. The page shows when tokens arrive.',
  ],
  [
    'Withdrawals are paid to the wallet you signed in with. From there you can move tokens wherever you like. Test tokens have no value and cannot be sent to a real exchange.',
    'Withdrawals are paid to the wallet you signed in with. From there you can move tokens wherever you like. Recent trading gains become withdrawable after the next on-chain state commitment.',
  ],
  ['Development status', 'Smart contract and beta status'],
  [
    'This platform is pre-launch software. It is not authorised to provide services and must not be used with real funds.',
    'The vault smart contract has not been independently audited. An internal review found and fixed two issues; others may exist. Deposits are capped in the contract to limit losses. You can lose all of your deposit. Only deposit what you can afford to lose.',
  ],
  [
    'Funds are held by a smart contract, not by us. Test tokens on a local or test chain only; they have no value.',
    'Funds are held by a smart contract, not by us. It has not been independently audited and deposits are capped: only deposit what you can afford to lose.',
  ],
  [
    'Not audited. Testnet only. Never send real assets to this contract.',
    'Not independently audited. Deposits are capped. Never send tokens straight to the contract address.',
  ],
  [
    'Not available on the testnet: test tokens have no value and cannot be bought.',
    'Not available yet.',
  ],
  [
    'Pre-launch: test chain only until the contract audit and legal review are complete.',
    'Real funds: the smart contract has not been independently audited and deposits are capped.',
  ],
  [
    'I understand this is pre-launch software and accept the risk disclosures.',
    'I understand the smart contract has not been independently audited, and I accept the risk disclosures.',
  ],
  [
    'Past performance does not predict future results. Leaders can lose your deposit. Test chain only until the contract audit and legal review are complete.',
    'Past performance does not predict future results. Leaders can lose your deposit.',
  ],
  [
    'No identity-document or sanctions-screening provider is integrated yet; reviews are manual and this environment holds no real funds.',
    'No identity-document or sanctions-screening provider is integrated yet; reviews are manual.',
  ],
  [
    'Deposits and withdrawals use test tokens on a local/test chain only (vault below). No real funds are held.',
    'Deposits and withdrawals go through the self-custody vault below.',
  ],
  ['Deposit (vault, testnet)', 'Deposit (vault)'],
  ['Withdrawal executed (testnet)', 'Withdrawal executed'],
];

/** Returns a copy of `dict` with every testnet sentence replaced. */
export function withRealFunds(dict: Dictionary): Dictionary {
  const map = new Map(REAL_FUNDS_REPLACEMENTS);
  const walk = (v: unknown): unknown =>
    typeof v === 'string'
      ? (map.get(v) ?? v)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(dict) as Dictionary;
}
