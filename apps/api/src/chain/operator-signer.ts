import { HttpStatus } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import type { Hex, PublicClient, WalletClient } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { AppError } from '../common/app-error';

export interface WithdrawalMessage {
  id: Hex;
  user: Hex;
  token: Hex;
  amount: bigint;
  afterState: bigint;
  expiry: bigint;
}

/**
 * Who holds the vault operator key (ADR-0015). The API never needs the key
 * itself: in every environment except local/ci it talks to the isolated
 * signer service, which applies its own limits.
 */
export interface OperatorSigner {
  readonly kind: 'local' | 'remote';
  /** The operator address the vault must be deployed with. */
  address(): Promise<Hex>;
  signWithdrawal(chainId: number, vault: Hex, message: WithdrawalMessage): Promise<Hex>;
  /** Sends commitState and waits for it; returns the transaction hash. */
  commitState(vault: Hex, index: bigint, root: Hex, lastDepositId: bigint): Promise<Hex>;
  /** Sends setDepositCap (launch guard, ADR-0033) and waits for it; returns the transaction hash. */
  setDepositCap(vault: Hex, token: Hex, cap: bigint): Promise<Hex>;
}

const WITHDRAWAL_TYPES = {
  Withdrawal: [
    { name: 'id', type: 'bytes32' },
    { name: 'user', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'afterState', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

/** Local/ci only: the key is in this process (refused elsewhere by the config). */
export class LocalOperatorSigner implements OperatorSigner {
  readonly kind = 'local' as const;
  constructor(
    private readonly account: PrivateKeyAccount,
    private readonly wallet: WalletClient,
    private readonly client: PublicClient,
    private readonly vaultAbi: readonly unknown[],
  ) {}

  address(): Promise<Hex> {
    return Promise.resolve(this.account.address);
  }

  signWithdrawal(chainId: number, vault: Hex, message: WithdrawalMessage): Promise<Hex> {
    return this.account.signTypedData({
      domain: { name: 'ExchangeVault', version: '1', chainId, verifyingContract: vault },
      types: WITHDRAWAL_TYPES,
      primaryType: 'Withdrawal',
      message,
    });
  }

  async commitState(vault: Hex, index: bigint, root: Hex, lastDepositId: bigint): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: vault,
      abi: this.vaultAbi as never,
      functionName: 'commitState',
      args: [index, root, lastDepositId] as never,
      account: this.account,
      chain: null,
    });
    const r = await this.client.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('commitState reverted');
    return hash;
  }

  async setDepositCap(vault: Hex, token: Hex, cap: bigint): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: vault,
      abi: this.vaultAbi as never,
      functionName: 'setDepositCap',
      args: [token, cap] as never,
      account: this.account,
      chain: null,
    });
    const r = await this.client.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('setDepositCap reverted');
    return hash;
  }
}

/** Calls the isolated signer service over HMAC-authenticated HTTP. */
export class RemoteOperatorSigner implements OperatorSigner {
  readonly kind = 'remote' as const;
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  async address(): Promise<Hex> {
    const r = await this.call<{ address?: Hex }>('/v1/address', undefined, 'GET');
    if (r.status !== 200 || !r.json.address) throw new Error(`Signer error ${r.status}`);
    return r.json.address;
  }

  private async call<T>(
    path: string,
    body: unknown,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<{ status: number; json: T }> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const ts = String(Date.now());
    const requestId = randomUUID();
    const signature = createHmac('sha256', this.secret)
      .update(`${ts}.${requestId}.${text}`)
      .digest('hex');
    const res = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        'content-type': 'application/json',
        'x-signer-timestamp': ts,
        'x-signer-request-id': requestId,
        'x-signer-signature': signature,
      },
      body: method === 'GET' ? undefined : text,
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, json: (await res.json()) as T };
  }

  async signWithdrawal(chainId: number, vault: Hex, m: WithdrawalMessage): Promise<Hex> {
    const r = await this.call<{ signature?: Hex; error?: string }>('/v1/sign/withdrawal', {
      chainId,
      vault,
      withdrawal: {
        id: m.id,
        user: m.user,
        token: m.token,
        amount: m.amount.toString(),
        afterState: m.afterState.toString(),
        expiry: m.expiry.toString(),
      },
    });
    if (r.status === 403) {
      // The signer's own limits refused it (e.g. daily limit): the user can retry later.
      throw new AppError(
        HttpStatus.CONFLICT,
        'LIMIT_EXCEEDED',
        `Withdrawal refused by the signing policy (${r.json.error ?? 'policy'})`,
      );
    }
    if (r.status !== 200 || !r.json.signature) throw new Error(`Signer error ${r.status}`);
    return r.json.signature;
  }

  async commitState(vault: Hex, index: bigint, root: Hex, lastDepositId: bigint): Promise<Hex> {
    const r = await this.call<{ txHash?: Hex; error?: string }>('/v1/commit-state', {
      vault,
      index: index.toString(),
      root,
      lastDepositId: lastDepositId.toString(),
    });
    if (r.status !== 200 || !r.json.txHash)
      throw new Error(`Signer refused commit: ${r.status} ${r.json.error ?? ''}`);
    return r.json.txHash;
  }

  async setDepositCap(vault: Hex, token: Hex, cap: bigint): Promise<Hex> {
    const r = await this.call<{ txHash?: Hex; error?: string }>('/v1/deposit-cap', {
      vault,
      token,
      cap: cap.toString(),
    });
    if (r.status !== 200 || !r.json.txHash)
      throw new Error(`Signer refused deposit cap: ${r.status} ${r.json.error ?? ''}`);
    return r.json.txHash;
  }
}
