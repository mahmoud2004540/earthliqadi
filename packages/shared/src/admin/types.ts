import { z } from 'zod';
import { amountStringSchema, assetCodeSchema } from '../money/amount';
import { marketSymbolSchema } from '../trading/types';

// ------------------------------------------------------------ notifications

export const markNotificationsReadSchema = z.object({
  /** Omit to mark everything read. */
  ids: z.array(z.uuid()).max(100).optional(),
});

export interface NotificationDto {
  id: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, string>;
  read: boolean;
  createdAt: string;
}

// ------------------------------------------------------- maker-checker approvals

const reason = z.string().trim().min(5).max(256);

/** Actions that always need a second staff member (ADR-0012). */
export const approvalRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('market.resume'),
    payload: z.object({ symbol: marketSymbolSchema }),
    reason,
  }),
  z.object({
    action: z.literal('insurance_fund.seed'),
    payload: z.object({ asset: assetCodeSchema, amount: amountStringSchema }),
    reason,
  }),
  z.object({
    action: z.literal('ledger.reversal'),
    payload: z.object({ entryId: z.string().regex(/^\d{1,19}$/) }),
    reason,
  }),
  z.object({
    action: z.literal('user.reactivate'),
    payload: z.object({ userId: z.uuid() }),
    reason,
  }),
  z.object({
    /** Fee revenue to the configured treasury wallet (ADR-0031). */
    action: z.literal('treasury.withdraw'),
    payload: z.object({ asset: assetCodeSchema, amount: amountStringSchema }),
    reason,
  }),
  z.object({
    /** On-chain deposit cap per vault token (ADR-0033); "unlimited" removes it. */
    action: z.literal('vault.deposit_cap'),
    payload: z.object({
      asset: assetCodeSchema,
      cap: z.union([amountStringSchema, z.literal('unlimited')]),
    }),
    reason,
  }),
  z.object({
    action: z.literal('role.grant'),
    payload: z.object({
      userId: z.uuid(),
      role: z.enum([
        'support_agent',
        'compliance_officer',
        'risk_officer',
        'auditor',
        'administrator',
      ]),
    }),
    reason,
  }),
]);
export type ApprovalRequestInput = z.infer<typeof approvalRequestSchema>;
export type ApprovalAction = ApprovalRequestInput['action'];

export const approvalDecisionSchema = z.object({
  note: z.string().trim().max(256).optional(),
});

export interface ApprovalDto {
  id: string;
  action: ApprovalAction;
  payload: Record<string, string>;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  result: Record<string, string> | null;
}

export const suspendUserSchema = z.object({ reason });

// ------------------------------------------------------------------- KYC

function adultDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d)
    return false;
  const now = new Date();
  const eighteen = new Date(
    Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()),
  );
  return date <= eighteen && y >= 1900;
}

export const kycSubmitSchema = z.object({
  legalName: z.string().trim().min(2).max(120),
  dateOfBirth: z
    .string()
    .refine(adultDate, 'Enter a valid date (YYYY-MM-DD); you must be 18 or older'),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use a two-letter country code (ISO 3166-1)'),
  addressLine: z.string().trim().min(3).max(200),
  city: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(20),
});
export type KycSubmitInput = z.infer<typeof kycSubmitSchema>;

export const kycDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'needs_info']),
  note: z.string().trim().min(3).max(512),
});

export type KycCaseStatusDto = 'pending' | 'approved' | 'rejected' | 'needs_info';

export interface KycStatusDto {
  level: number;
  case: {
    id: string;
    status: KycCaseStatusDto;
    submittedAt: string;
    decidedAt: string | null;
    /** Shown to the user for rejected / needs-info decisions. */
    note: string | null;
  } | null;
}

export interface KycReviewDto {
  id: string;
  userId: string;
  email: string;
  status: KycCaseStatusDto;
  level: number;
  countryCode: string;
  screening: {
    restrictedCountry: boolean;
    sanctions: 'not_screened' | 'clear' | 'hit';
    sanctionsProvider: string;
  };
  submittedAt: string;
  /** Decrypted only on the single-case endpoint (access is audited). */
  profile?: KycSubmitInput;
}

// --------------------------------------------------------------- support

export const createTicketSchema = z.object({
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(5000),
});

export const ticketReplySchema = z.object({ body: z.string().trim().min(1).max(5000) });

export interface TicketMessageDto {
  id: string;
  fromStaff: boolean;
  body: string;
  createdAt: string;
}

export interface TicketDto {
  id: string;
  subject: string;
  status: 'open' | 'waiting_on_user' | 'closed';
  createdAt: string;
  updatedAt: string;
  /** Staff views only. */
  userEmail?: string;
  messages?: TicketMessageDto[];
}

// ---------------------------------------------------------- announcements

export const announcementSchema = z.object({
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(5000),
});

export interface AnnouncementDto {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
}

// ------------------------------------------------------------------ health

export interface SystemHealthDto {
  generatedAt: string;
  markets: {
    symbol: string;
    kind: 'spot' | 'perpetual';
    status: string;
    engineBacklog: string;
    settlementLag: string;
    indexStale: boolean | null;
  }[];
  reconciliation: { status: string; startedAt: string; findings: number } | null;
  insuranceFunds: { asset: string; balance: string }[];
  queues: { approvalsPending: number; kycPending: number; ticketsOpen: number };
  positionsLiquidating: number;
}

// ------------------------------------------------------------- vault (ADR-0014)

export const withdrawalRequestSchema = z.object({
  asset: assetCodeSchema,
  amount: amountStringSchema,
});

export interface VaultConfigDto {
  enabled: boolean;
  chainId: number | null;
  vault: string | null;
  tokens: {
    asset: string;
    address: string;
    decimals: number;
    /** On-chain deposit cap (launch guard, ADR-0033), or null when uncapped. */
    depositCap?: string | null;
    /** Deposits minus payouts the cap is measured against. */
    held?: string;
  }[];
  freezeDelaySeconds: number | null;
  /** False only on a real-value network (CHAIN_MAINNET, ADR-0038). */
  testnet: boolean;
  /** Local chain only. */
  faucet?: boolean;
  /** Network name, explorer and public RPC for wallets (ADR-0034). */
  network?: {
    name: string;
    rpcUrl: string;
    explorerUrl: string | null;
    gasFaucetInfo: string | null;
  } | null;
  /** Public testnets: the test tokens can be minted from the user's own wallet. */
  selfMint?: boolean;
  /** Blocks a deposit waits before it is credited. */
  confirmations?: number;
}

/**
 * What the signed-in wallet holds on the vault network, outside the exchange
 * (ADR-0036). Used to offer "move to exchange" when tokens arrive.
 */
export interface WalletBalancesDto {
  address: string;
  chainId: number;
  /** Native test ETH for network fees, as a decimal string. */
  gas: string;
  tokens: { asset: string; balance: string }[];
}

export interface WithdrawalDto {
  id: string;
  asset: string;
  amount: string;
  status: 'signed' | 'executed' | 'expired';
  createdAt: string;
  expiresAt: string;
  txHash: string | null;
  /** Everything the wallet needs to call ExchangeVault.withdraw(w, signature). */
  call: {
    chainId: number;
    vault: string;
    withdrawal: {
      id: string;
      user: string;
      token: string;
      amount: string;
      afterState: string;
      expiry: string;
    };
    signature: string;
  };
}

export interface VaultProofDto {
  stateIndex: string | null;
  root: string | null;
  lastDepositId: string | null;
  entries: {
    asset: string;
    token: string;
    /** Minor units (as committed on-chain). */
    balance: string;
    balanceFormatted: string;
    proof: string[];
  }[];
  /**
   * Signed withdrawals not executed on-chain. Keep them with the proof: after
   * a freeze, ExchangeVault.withdrawAfterFreeze pays those the frozen root no
   * longer contains (the contract decides which).
   */
  unexecutedWithdrawals: WithdrawalDto['call'][];
}

/** Treasury (ADR-0031): fee revenue per vault asset and treasury withdrawals. */
export interface TreasuryDto {
  /** Configured treasury wallet, or null when treasury withdrawals are disabled. */
  address: string | null;
  balances: { asset: string; feeRevenue: string; withdrawing: string }[];
  withdrawals: {
    id: string;
    asset: string;
    amount: string;
    status: 'signed' | 'executed' | 'expired';
    approvalId: string;
    createdAt: string;
    txHash: string | null;
  }[];
}
