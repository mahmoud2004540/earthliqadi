/**
 * Signing policy (ADR-0015). Pure and deterministic: the server feeds it the
 * clock and persists every decision. A compromised API can only obtain
 * signatures that pass these limits.
 */
export interface TokenLimit {
  /** Maximum amount per withdrawal, token minor units. */
  perTx: bigint;
  /** Maximum total per UTC day, token minor units. */
  daily: bigint;
}

export interface PolicyConfig {
  chainId: number;
  vault: string; // lower-case
  limits: Map<string, TokenLimit>; // lower-case token → limit
  maxTtlSeconds: number;
}

export interface WithdrawalRequest {
  chainId: number;
  vault: string;
  id: string;
  user: string;
  token: string;
  amount: bigint;
  afterState: bigint;
  expiry: bigint;
}

export class PolicyError extends Error {
  constructor(
    readonly code:
      | 'WRONG_CHAIN'
      | 'WRONG_VAULT'
      | 'TOKEN_NOT_ALLOWED'
      | 'BAD_AMOUNT'
      | 'PER_TX_LIMIT'
      | 'DAILY_LIMIT'
      | 'BAD_EXPIRY'
      | 'DUPLICATE_ID',
    message: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class SigningPolicy {
  private readonly usedIds = new Set<string>();
  /** `${day}|${token}` → total signed. */
  private readonly daily = new Map<string, bigint>();

  constructor(private readonly config: PolicyConfig) {}

  /** Rebuilds state from the audit log (signed withdrawals only). */
  replay(entry: { id: string; token: string; amount: bigint; at: Date }): void {
    this.usedIds.add(entry.id.toLowerCase());
    const k = `${utcDay(entry.at)}|${entry.token.toLowerCase()}`;
    this.daily.set(k, (this.daily.get(k) ?? 0n) + entry.amount);
  }

  /**
   * `chainNow` (seconds) is the chain's clock, which the contract uses for
   * expiry; the window is measured from the later of the two clocks.
   */
  check(w: WithdrawalRequest, now: Date, chainNow?: bigint): void {
    const c = this.config;
    if (w.chainId !== c.chainId)
      throw new PolicyError('WRONG_CHAIN', `Chain ${w.chainId} not allowed`);
    if (w.vault.toLowerCase() !== c.vault)
      throw new PolicyError('WRONG_VAULT', 'Vault not allowed');
    const limit = c.limits.get(w.token.toLowerCase());
    if (!limit) throw new PolicyError('TOKEN_NOT_ALLOWED', 'Token not allowed');
    if (w.amount <= 0n) throw new PolicyError('BAD_AMOUNT', 'Amount must be positive');
    if (w.amount > limit.perTx)
      throw new PolicyError('PER_TX_LIMIT', 'Per-withdrawal limit exceeded');
    const wallS = BigInt(Math.floor(now.getTime() / 1000));
    const nowS = chainNow !== undefined && chainNow > wallS ? chainNow : wallS;
    if (w.expiry <= nowS || w.expiry > nowS + BigInt(c.maxTtlSeconds))
      throw new PolicyError('BAD_EXPIRY', 'Expiry outside the allowed window');
    if (this.usedIds.has(w.id.toLowerCase()))
      throw new PolicyError('DUPLICATE_ID', 'Withdrawal id already signed');
    const k = `${utcDay(now)}|${w.token.toLowerCase()}`;
    if ((this.daily.get(k) ?? 0n) + w.amount > limit.daily)
      throw new PolicyError('DAILY_LIMIT', 'Daily limit exceeded for this token');
  }

  record(w: WithdrawalRequest, now: Date): void {
    this.replay({ id: w.id, token: w.token, amount: w.amount, at: now });
  }
}
