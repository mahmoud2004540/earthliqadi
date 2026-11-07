import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type ChainDeployment } from '@prisma/client';
import {
  formatAmount,
  formatAmountTrimmed,
  parseAmount,
  type VaultConfigDto,
  type VaultProofDto,
  type WithdrawalDto,
  type TreasuryDto,
} from '@platform/shared';
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbiItem,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { toMinorUnits } from '../ledger/ledger-domain';
import { LedgerService, type LedgerActor } from '../ledger/ledger.service';
import { RbacService } from '../rbac/rbac.service';
import vaultArtifact from './artifacts/ExchangeVault.json';
import tokenArtifact from './artifacts/TestToken.json';
import { buildTree, leafHash, proofFor, type BalanceLeaf } from './merkle';
import { LocalOperatorSigner, RemoteOperatorSigner, type OperatorSigner } from './operator-signer';

/** Testnets and local chains only (ADR-0014). Mainnets are refused outright. */
export const ALLOWED_CHAIN_IDS = new Set([31337, 11155111, 17000, 84532, 421614]);

const CHAIN_ACTOR: LedgerActor = { actorType: 'SYSTEM', requestId: 'chain-indexer' };
const STATE_LOCK_KEY = 0x7661756c74; // "vault"
const MAX_LOG_RANGE = 2000n;

const VAULT_ABI = vaultArtifact.abi;
const TOKEN_ABI = tokenArtifact.abi;
const DEPOSITED = parseAbiItem(
  'event Deposited(uint64 indexed id, address indexed user, address indexed token, uint256 amount)',
);
const WITHDRAWN = parseAbiItem(
  'event Withdrawn(bytes32 indexed id, address indexed user, address indexed token, uint256 amount)',
);

export class ChainInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainInvariantError';
  }
}

function conflict(message: string): AppError {
  return new AppError(HttpStatus.CONFLICT, 'CONFLICT', message);
}

const lower = (a: string): string => a.toLowerCase();

/**
 * Bridge between the off-chain ledger and the on-chain vault (ADR-0014).
 * - Indexer: credits deposits and finalises withdrawals from vault events,
 *   only up to `head − CHAIN_CONFIRMATIONS`, idempotently per event.
 * - Withdrawals: holds funds in USER_WITHDRAWING, then signs an EIP-712
 *   withdrawal the user submits from their wallet. Unexecuted withdrawals are
 *   released only once the indexed chain time has passed their expiry.
 * - State commitments: Merkle root of every wallet's balance per vault token,
 *   so users can leave without the operator (escape hatch).
 */
@Injectable()
export class ChainService {
  private readonly logger = new Logger(ChainService.name);
  private readonly client: PublicClient | null;
  private readonly wallet: WalletClient | null;
  private readonly account: PrivateKeyAccount | null;
  private chainIdCache: number | null = null;
  private readonly operatorSigner: OperatorSigner | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    const url = config.CHAIN_RPC_URL;
    this.client = url ? createPublicClient({ transport: http(url), cacheTime: 0 }) : null;
    this.account = config.CHAIN_OPERATOR_KEY
      ? privateKeyToAccount(config.CHAIN_OPERATOR_KEY as Hex)
      : null;
    this.wallet =
      url && this.account
        ? createWalletClient({ account: this.account, transport: http(url) })
        : null;
    this.operatorSigner = config.SIGNER_URL
      ? new RemoteOperatorSigner(config.SIGNER_URL, config.SIGNER_HMAC_SECRET!)
      : this.wallet && this.account && this.client
        ? new LocalOperatorSigner(this.account, this.wallet, this.client, VAULT_ABI)
        : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  private rpc(): PublicClient {
    if (!this.client) throw AppError.notFound('The vault is not configured in this environment');
    return this.client;
  }

  private operator(): OperatorSigner {
    if (!this.operatorSigner) throw conflict('No operator signer is configured');
    return this.operatorSigner;
  }

  private signer(): { wallet: WalletClient; account: PrivateKeyAccount } {
    if (!this.wallet || !this.account) throw conflict('No operator signer is configured');
    return { wallet: this.wallet, account: this.account };
  }

  async chainId(): Promise<number> {
    if (this.chainIdCache === null) {
      const id = await this.rpc().getChainId();
      if (!ALLOWED_CHAIN_IDS.has(id))
        throw new ChainInvariantError(`Chain ${id} is not an allowed testnet (ADR-0014)`);
      this.chainIdCache = id;
    }
    return this.chainIdCache;
  }

  async deployment(): Promise<ChainDeployment | null> {
    if (!this.enabled) return null;
    return this.prisma.chainDeployment.findUnique({ where: { chainId: await this.chainId() } });
  }

  private vaultAssetCache = new Map<string, string[]>();

  /** Assets whose token the CURRENT vault accepts (the contract's allowlist is authoritative). */
  private async vaultAssets(d: ChainDeployment) {
    const candidates = await this.prisma.asset.findMany({
      where: { chainTokenAddress: { not: null } },
      orderBy: { code: 'asc' },
    });
    let accepted = this.vaultAssetCache.get(d.vaultAddress);
    if (!accepted) {
      accepted = [];
      for (const a of candidates) {
        const ok = (await this.rpc().readContract({
          address: d.vaultAddress as Hex,
          abi: VAULT_ABI as never,
          functionName: 'isToken',
          args: [a.chainTokenAddress as Hex] as never,
        })) as boolean;
        if (ok) accepted.push(a.chainTokenAddress!);
      }
      this.vaultAssetCache.set(d.vaultAddress, accepted);
    }
    return candidates.filter((a) => accepted.includes(a.chainTokenAddress!));
  }

  private async requireDeployment(): Promise<ChainDeployment> {
    const d = await this.deployment();
    if (!d) throw AppError.notFound('No vault is deployed for this chain');
    return d;
  }

  private async send(to: Hex, abi: readonly unknown[], functionName: string, args: unknown[]) {
    const { wallet, account } = this.signer();
    const hash = await wallet.writeContract({
      address: to,
      abi: abi as never,
      functionName: functionName,
      args: args,
      account,
      chain: null,
    });
    const receipt = await this.rpc().waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new ChainInvariantError(`${functionName} reverted`);
    return { hash, receipt };
  }

  // -------------------------------------------------------------- deploy

  /**
   * Deploys test tokens and the vault (local/testnet), links real assets to the
   * tokens and records the deployment. Used by the CLI and the tests.
   */
  async deploy(input: {
    tokens: { code: string; name: string; decimals: number; faucetLimit: bigint }[];
    freezeDelaySeconds: number;
  }): Promise<{ vault: Hex; tokens: Record<string, Hex> }> {
    const { wallet, account } = this.signer();
    const chainId = await this.chainId();
    if (chainId === 31337) {
      // Local chain: give the development operator test ETH for gas.
      await this.rpc().request({
        method: 'anvil_setBalance' as never,
        params: [account.address, '0x56BC75E2D63100000'] as never, // 100 test ETH
      });
    }
    const tokens: Record<string, Hex> = {};
    for (const t of input.tokens) {
      const hash = await wallet.deployContract({
        abi: TOKEN_ABI as never,
        bytecode: tokenArtifact.bytecode as Hex,
        args: [`${t.name} (test, no value)`, t.code, t.decimals, t.faucetLimit] as never,
        account,
        chain: null,
      });
      const r = await this.rpc().waitForTransactionReceipt({ hash });
      tokens[t.code] = r.contractAddress!;
    }
    const hash = await wallet.deployContract({
      abi: VAULT_ABI as never,
      bytecode: vaultArtifact.bytecode as Hex,
      args: [account.address, BigInt(input.freezeDelaySeconds), Object.values(tokens)] as never,
      account,
      chain: null,
    });
    const receipt = await this.rpc().waitForTransactionReceipt({ hash });
    const vault = receipt.contractAddress!;
    for (const t of input.tokens) {
      const existing = await this.prisma.asset.findUnique({ where: { code: t.code } });
      if (!existing) {
        await this.ledger.createAsset(
          { code: t.code, name: `${t.name} (testnet, no value)`, scale: t.decimals },
          { actorType: 'SYSTEM' },
        );
      }
      await this.prisma.asset.update({
        where: { code: t.code },
        data: { chainTokenAddress: lower(tokens[t.code]!) },
      });
    }
    await this.prisma.chainDeployment.upsert({
      where: { chainId },
      create: {
        chainId,
        vaultAddress: lower(vault),
        operatorAddress: lower(account.address),
        deployBlock: receipt.blockNumber,
      },
      update: {
        vaultAddress: lower(vault),
        operatorAddress: lower(account.address),
        deployBlock: receipt.blockNumber,
      },
    });
    await this.prisma.chainCursor.upsert({
      where: { chainId },
      create: { chainId, lastBlock: receipt.blockNumber },
      update: { lastBlock: receipt.blockNumber, lastBlockHash: null, lastBlockTime: null },
    });
    await this.audit.record({
      action: 'chain.vault.deployed',
      outcome: 'SUCCESS',
      actorType: 'SYSTEM',
      targetType: 'vault',
      targetId: lower(vault),
      metadata: { chainId, tokens, operator: account.address },
    });
    return { vault, tokens };
  }

  // ------------------------------------------------------------- indexer

  /** Processes one range of confirmed blocks. Returns the number of events applied. */
  async indexOnce(): Promise<number> {
    const d = await this.deployment();
    if (!d) return 0;
    const client = this.rpc();
    const cursor = await this.prisma.chainCursor.findUniqueOrThrow({
      where: { chainId: d.chainId },
    });
    const head = await client.getBlockNumber();
    const safe = head - BigInt(this.config.CHAIN_CONFIRMATIONS);
    if (safe <= cursor.lastBlock) return 0;
    const from = cursor.lastBlock + 1n;
    const to = safe - from + 1n > MAX_LOG_RANGE ? from + MAX_LOG_RANGE - 1n : safe;
    const logs = await client.getLogs({
      address: d.vaultAddress as Hex,
      events: [DEPOSITED, WITHDRAWN],
      fromBlock: from,
      toBlock: to,
    });
    const toBlock = await client.getBlock({ blockNumber: to });
    const assets = await this.vaultAssets(d);
    const byToken = new Map(assets.map((a) => [a.chainTokenAddress!, a]));
    let accounts: ReturnType<LedgerService['transactionalAccounts']> | null = null;

    await this.prisma.$transaction(
      async (tx) => {
        const acc = this.ledger.transactionalAccounts(tx);
        accounts = acc;
        const ordered = [...logs].sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : a.blockNumber < b.blockNumber
              ? -1
              : 1,
        );
        for (const log of ordered) {
          const ev = decodeEventLog({
            abi: [DEPOSITED, WITHDRAWN],
            data: log.data,
            topics: log.topics,
          });
          if (ev.eventName === 'Deposited') {
            const { id, user, token, amount } = ev.args;
            const asset = byToken.get(lower(token));
            if (!asset) throw new ChainInvariantError(`Deposit of unlinked token ${token}`);
            const exists = await tx.chainDeposit.findUnique({
              where: {
                chainId_vaultAddress_depositId: {
                  chainId: d.chainId,
                  vaultAddress: d.vaultAddress,
                  depositId: id,
                },
              },
            });
            if (exists) continue; // idempotent replay of a range
            const userId = await this.walletUser(tx, lower(user));
            const key = `chain-deposit:${d.chainId}:${d.vaultAddress}:${id}`;
            const entry = await this.ledger.postWithin(
              tx,
              {
                type: 'CHAIN_DEPOSIT',
                idempotencyKey: key,
                description: `Vault deposit #${id} (testnet)`,
                postings: [
                  {
                    accountId: await acc.id(asset.id, 'VAULT_CUSTODY', null),
                    direction: 'DEBIT',
                    amount,
                  },
                  {
                    accountId: await acc.id(asset.id, 'USER_AVAILABLE', userId),
                    direction: 'CREDIT',
                    amount,
                  },
                ],
              },
              CHAIN_ACTOR,
            );
            await tx.chainDeposit.create({
              data: {
                chainId: d.chainId,
                vaultAddress: d.vaultAddress,
                depositId: id,
                txHash: log.transactionHash,
                logIndex: log.logIndex,
                blockNumber: log.blockNumber,
                blockHash: log.blockHash,
                walletAddress: lower(user),
                assetId: asset.id,
                userId,
                amount: amount.toString(),
                journalEntryId: entry.entry.id,
              },
            });
          } else {
            const { id, token, amount } = ev.args;
            const w = await tx.withdrawal.findUnique({ where: { id: lower(id) } });
            // A withdrawal we never signed means the operator key is compromised: halt.
            if (!w) throw new ChainInvariantError(`Unknown withdrawal ${id} executed on-chain`);
            if (w.vaultAddress !== d.vaultAddress)
              throw new ChainInvariantError(`Withdrawal ${id} belongs to another vault`);
            if (w.status === 'EXECUTED') continue;
            if (w.status !== 'SIGNED' || toMinorUnits(w.amount) !== amount)
              throw new ChainInvariantError(`Withdrawal ${id} does not match the ledger`);
            const asset = byToken.get(lower(token));
            if (!asset || asset.id !== w.assetId)
              throw new ChainInvariantError(`Withdrawal ${id} token mismatch`);
            await this.ledger.postWithin(
              tx,
              {
                type: 'WITHDRAWAL_FINAL',
                idempotencyKey: `withdrawal-final:${w.id}`,
                description: `Vault withdrawal executed (testnet)`,
                postings: [
                  {
                    // A treasury withdrawal spends the treasury hold, never a customer's.
                    accountId: w.isTreasury
                      ? await acc.id(asset.id, 'TREASURY_WITHDRAWING', null)
                      : await acc.id(asset.id, 'USER_WITHDRAWING', w.userId),
                    direction: 'DEBIT',
                    amount,
                  },
                  {
                    accountId: await acc.id(asset.id, 'VAULT_CUSTODY', null),
                    direction: 'CREDIT',
                    amount,
                  },
                ],
              },
              CHAIN_ACTOR,
            );
            await tx.withdrawal.update({
              where: { id: w.id },
              data: { status: 'EXECUTED', txHash: log.transactionHash, finalisedAt: new Date() },
            });
          }
        }
        await tx.chainCursor.update({
          where: { chainId: d.chainId },
          data: {
            lastBlock: to,
            lastBlockHash: toBlock.hash,
            lastBlockTime: new Date(Number(toBlock.timestamp) * 1000),
          },
        });
      },
      { timeout: 60_000 },
    );
    (accounts as ReturnType<LedgerService['transactionalAccounts']> | null)?.commit();
    return logs.length;
  }

  /** Wallet accounts are created on first sign-in or first deposit, whichever comes first. */
  private async walletUser(tx: Prisma.TransactionClient, wallet: string): Promise<string> {
    const found = await tx.user.findUnique({ where: { walletAddress: wallet } });
    if (found) return found.id;
    const created = await tx.user.create({ data: { walletAddress: wallet, status: 'ACTIVE' } });
    await this.rbac.assignDefaultRole(created.id, tx);
    return created.id;
  }

  // --------------------------------------------------------- withdrawals

  private async latestStateIndex(
    tx: Prisma.TransactionClient,
    d: ChainDeployment,
  ): Promise<bigint> {
    const s = await tx.vaultState.findFirst({
      where: { chainId: d.chainId, vaultAddress: d.vaultAddress },
      orderBy: { index: 'desc' },
    });
    return s?.index ?? 0n;
  }

  async requestWithdrawal(
    userId: string,
    assetCode: string,
    amountText: string,
  ): Promise<WithdrawalDto> {
    const d = await this.requireDeployment();
    const operator = this.operator();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.walletAddress) throw conflict('Withdrawals go to your wallet: sign in with a wallet');
    const asset = await this.ledger.requireAsset(assetCode);
    if (!asset.chainTokenAddress) throw conflict(`${assetCode} is not held in the vault`);
    let amount: bigint;
    try {
      amount = parseAmount(amountText, asset.scale);
    } catch (err) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', (err as Error).message);
    }
    if (amount <= 0n)
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Amount must be positive');
    const available = await this.ledger.accountId(asset.id, 'USER_AVAILABLE', userId);
    const withdrawing = await this.ledger.accountId(asset.id, 'USER_WITHDRAWING', userId);
    const id: Hex = `0x${randomBytes(32).toString('hex')}`;
    // The contract checks expiry against chain time, which may differ from this server's clock.
    const head = await this.rpc().getBlock();
    const chainNowMs = Math.max(Date.now(), Number(head.timestamp) * 1000);
    const expiry = new Date(chainNowMs + this.config.VAULT_WITHDRAWAL_TTL_SECONDS * 1000);

    const row = await this.prisma.$transaction(async (tx) => {
      // Shared lock: a snapshot cannot be taken between reading the state index and the hold.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${STATE_LOCK_KEY})`;
      const afterState = await this.latestStateIndex(tx, d);
      await this.ledger.postWithin(
        tx,
        {
          type: 'WITHDRAWAL_HOLD',
          idempotencyKey: `withdrawal-hold:${id}`,
          description: `Withdrawal to ${getAddress(user.walletAddress!)} (testnet)`,
          postings: [
            { accountId: available, direction: 'DEBIT', amount },
            { accountId: withdrawing, direction: 'CREDIT', amount },
          ],
        },
        { actorType: 'USER', actorUserId: userId },
      );
      const message = {
        id,
        user: getAddress(user.walletAddress!),
        token: getAddress(asset.chainTokenAddress!),
        amount,
        afterState,
        expiry: BigInt(Math.floor(expiry.getTime() / 1000)),
      };
      const signature = await operator.signWithdrawal(d.chainId, d.vaultAddress as Hex, message);
      return tx.withdrawal.create({
        data: {
          id,
          chainId: d.chainId,
          vaultAddress: d.vaultAddress,
          userId,
          assetId: asset.id,
          walletAddress: user.walletAddress!,
          amount: amount.toString(),
          afterState,
          expiry: new Date(Number(message.expiry) * 1000),
          signature,
        },
        include: { asset: true },
      });
    });
    await this.audit.record({
      action: 'vault.withdrawal.signed',
      outcome: 'SUCCESS',
      actorType: 'USER',
      actorUserId: userId,
      targetType: 'withdrawal',
      targetId: row.id,
      metadata: {
        asset: assetCode,
        amount: amount.toString(),
        afterState: row.afterState.toString(),
      },
    });
    return this.withdrawalDto(row, d);
  }

  private withdrawalDto(
    w: Prisma.WithdrawalGetPayload<{ include: { asset: true } }>,
    d: ChainDeployment,
  ): WithdrawalDto {
    return {
      id: w.id,
      asset: w.asset.code,
      amount: formatAmountTrimmed(toMinorUnits(w.amount), w.asset.scale),
      status: w.status.toLowerCase() as WithdrawalDto['status'],
      createdAt: w.createdAt.toISOString(),
      expiresAt: w.expiry.toISOString(),
      txHash: w.txHash,
      call: {
        chainId: d.chainId,
        vault: getAddress(d.vaultAddress),
        withdrawal: {
          id: w.id,
          user: getAddress(w.walletAddress),
          token: getAddress(w.asset.chainTokenAddress!),
          amount: toMinorUnits(w.amount).toString(),
          afterState: w.afterState.toString(),
          expiry: Math.floor(w.expiry.getTime() / 1000).toString(),
        },
        signature: w.signature,
      },
    };
  }

  async withdrawals(userId: string): Promise<WithdrawalDto[]> {
    const d = await this.requireDeployment();
    const rows = await this.prisma.withdrawal.findMany({
      where: { userId, vaultAddress: d.vaultAddress },
      include: { asset: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.withdrawalDto(r, d));
  }

  /** Releases holds of withdrawals that can no longer execute (indexed chain time > expiry). */
  async expireWithdrawals(): Promise<number> {
    const d = await this.deployment();
    if (!d) return 0;
    const cursor = await this.prisma.chainCursor.findUnique({ where: { chainId: d.chainId } });
    if (!cursor?.lastBlockTime) return 0;
    const stale = await this.prisma.withdrawal.findMany({
      where: {
        chainId: d.chainId,
        vaultAddress: d.vaultAddress,
        status: 'SIGNED',
        expiry: { lt: cursor.lastBlockTime },
      },
    });
    for (const w of stale) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.withdrawal.updateMany({
          where: { id: w.id, status: 'SIGNED' },
          data: { status: 'EXPIRED', finalisedAt: new Date() },
        });
        if (updated.count !== 1) return;
        const amount = toMinorUnits(w.amount);
        await this.ledger.postWithin(
          tx,
          {
            type: 'WITHDRAWAL_RELEASE',
            idempotencyKey: `withdrawal-release:${w.id}`,
            description: 'Withdrawal expired unexecuted: funds returned',
            // A treasury hold returns to fee revenue; a customer's to their available balance.
            postings: w.isTreasury
              ? [
                  {
                    accountId: await this.ledger.accountId(w.assetId, 'TREASURY_WITHDRAWING', null),
                    direction: 'DEBIT',
                    amount,
                  },
                  {
                    accountId: await this.ledger.accountId(w.assetId, 'FEE_REVENUE', null),
                    direction: 'CREDIT',
                    amount,
                  },
                ]
              : [
                  {
                    accountId: await this.ledger.accountId(w.assetId, 'USER_WITHDRAWING', w.userId),
                    direction: 'DEBIT',
                    amount,
                  },
                  {
                    accountId: await this.ledger.accountId(w.assetId, 'USER_AVAILABLE', w.userId),
                    direction: 'CREDIT',
                    amount,
                  },
                ],
          },
          CHAIN_ACTOR,
        );
      });
    }
    return stale.length;
  }

  // ----------------------------------------------------- treasury (ADR-0031)

  /** Free fee revenue of a vault asset, in minor units. */
  private async feeRevenue(assetId: string): Promise<bigint> {
    const id = await this.ledger.accountId(assetId, 'FEE_REVENUE', null);
    const acc = await this.prisma.ledgerAccount.findUnique({ where: { id } });
    return acc ? toMinorUnits(acc.balance) : 0n;
  }

  /** Validates a treasury withdrawal before it is requested; returns the amount in minor units. */
  async treasuryPrecheck(assetCode: string, amountText: string): Promise<bigint> {
    if (!this.config.TREASURY_ADDRESS)
      throw conflict('No treasury wallet is configured (TREASURY_ADDRESS)');
    await this.requireDeployment();
    const asset = await this.ledger.requireAsset(assetCode);
    if (!asset.chainTokenAddress) throw conflict(`${assetCode} is not held in the vault`);
    let amount: bigint;
    try {
      amount = parseAmount(amountText, asset.scale);
    } catch (err) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', (err as Error).message);
    }
    if (amount <= 0n)
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Amount must be positive');
    if (amount > (await this.feeRevenue(asset.id)))
      throw conflict('The amount is more than the collected fee revenue');
    return amount;
  }

  /**
   * Pays approved fee revenue to TREASURY_ADDRESS (ADR-0031): holds it from
   * FEE_REVENUE, signs a vault withdrawal to the treasury and, when this
   * process holds a sending key, submits it. Customer balances are never
   * touched. Idempotent per approval request.
   */
  async treasuryWithdraw(
    assetCode: string,
    amountText: string,
    approvalId: string,
    actor: { actorType: 'STAFF'; actorUserId: string; requestId?: string | null },
  ): Promise<{ withdrawalId: string; status: string; txHash: string | null }> {
    const existing = await this.prisma.withdrawal.findFirst({ where: { approvalId } });
    if (existing)
      return { withdrawalId: existing.id, status: existing.status, txHash: existing.txHash };
    const amount = await this.treasuryPrecheck(assetCode, amountText);
    const d = await this.requireDeployment();
    const operator = this.operator();
    const asset = await this.ledger.requireAsset(assetCode);
    const treasury = getAddress(this.config.TREASURY_ADDRESS);
    const fees = await this.ledger.accountId(asset.id, 'FEE_REVENUE', null);
    const holding = await this.ledger.accountId(asset.id, 'TREASURY_WITHDRAWING', null);
    const id: Hex = `0x${randomBytes(32).toString('hex')}`;
    const head = await this.rpc().getBlock();
    const chainNowMs = Math.max(Date.now(), Number(head.timestamp) * 1000);
    const expiry = new Date(chainNowMs + this.config.VAULT_WITHDRAWAL_TTL_SECONDS * 1000);

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${STATE_LOCK_KEY})`;
      const afterState = await this.latestStateIndex(tx, d);
      // FEE_REVENUE cannot go negative: the ledger refuses more than was collected.
      await this.ledger.postWithin(
        tx,
        {
          type: 'WITHDRAWAL_HOLD',
          idempotencyKey: `treasury-hold:${approvalId}`,
          description: `Treasury withdrawal to ${treasury} (approval ${approvalId})`,
          postings: [
            { accountId: fees, direction: 'DEBIT', amount },
            { accountId: holding, direction: 'CREDIT', amount },
          ],
        },
        actor,
      );
      const message = {
        id,
        user: treasury,
        token: getAddress(asset.chainTokenAddress!),
        amount,
        afterState,
        expiry: BigInt(Math.floor(expiry.getTime() / 1000)),
      };
      const signature = await operator.signWithdrawal(d.chainId, d.vaultAddress as Hex, message);
      return tx.withdrawal.create({
        data: {
          id,
          chainId: d.chainId,
          vaultAddress: d.vaultAddress,
          userId: null,
          isTreasury: true,
          approvalId,
          assetId: asset.id,
          walletAddress: treasury.toLowerCase(),
          amount: amount.toString(),
          afterState,
          expiry: new Date(Number(message.expiry) * 1000),
          signature,
        },
      });
    });
    await this.audit.record({
      action: 'treasury.withdrawal.signed',
      outcome: 'SUCCESS',
      actorType: 'STAFF',
      actorUserId: actor.actorUserId,
      targetType: 'withdrawal',
      targetId: row.id,
      metadata: { asset: assetCode, amount: amount.toString(), treasury, approvalId },
    });
    let txHash: string | null = null;
    if (this.wallet && this.account) {
      // Anyone may relay a signed withdrawal; the funds can only reach the treasury.
      const sent = await this.send(d.vaultAddress as Hex, VAULT_ABI, 'withdraw', [
        {
          id: row.id as Hex,
          user: treasury,
          token: getAddress(asset.chainTokenAddress!),
          amount,
          afterState: row.afterState,
          expiry: BigInt(Math.floor(row.expiry.getTime() / 1000)),
        },
        row.signature,
      ]);
      txHash = sent.hash;
    }
    return { withdrawalId: row.id, status: 'SIGNED', txHash };
  }

  async treasury(): Promise<TreasuryDto> {
    const d = await this.deployment();
    const address = this.config.TREASURY_ADDRESS ? getAddress(this.config.TREASURY_ADDRESS) : null;
    if (!d) return { address, balances: [], withdrawals: [] };
    const assets = await this.vaultAssets(d);
    const balances: TreasuryDto['balances'] = [];
    for (const a of assets) {
      const held = await this.prisma.ledgerAccount.findFirst({
        where: { assetId: a.id, type: 'TREASURY_WITHDRAWING' },
      });
      balances.push({
        asset: a.code,
        feeRevenue: formatAmountTrimmed(await this.feeRevenue(a.id), a.scale),
        withdrawing: formatAmountTrimmed(held ? toMinorUnits(held.balance) : 0n, a.scale),
      });
    }
    const rows = await this.prisma.withdrawal.findMany({
      where: { isTreasury: true, vaultAddress: d.vaultAddress },
      include: { asset: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      address,
      balances,
      withdrawals: rows.map((w) => ({
        id: w.id,
        asset: w.asset.code,
        amount: formatAmountTrimmed(toMinorUnits(w.amount), w.asset.scale),
        status: w.status.toLowerCase() as TreasuryDto['withdrawals'][number]['status'],
        approvalId: w.approvalId!,
        createdAt: w.createdAt.toISOString(),
        txHash: w.txHash,
      })),
    };
  }

  // ----------------------------------------------------- state commitments

  /**
   * Commits the pending snapshot, or takes a new one and commits it. Each
   * wallet's leaf = available + locked + margin of every vault token
   * (withdrawals in flight are excluded; the contract subtracts them).
   */
  async commitState(): Promise<bigint | null> {
    const d = await this.deployment();
    if (!d) return null;
    let state = await this.prisma.vaultState.findFirst({
      where: { chainId: d.chainId, vaultAddress: d.vaultAddress, status: 'PENDING' },
    });
    if (!state) {
      const tokens = (await this.vaultAssets(d)).map((x) => x.chainTokenAddress!);
      state = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${STATE_LOCK_KEY})`;
          const index = (await this.latestStateIndex(tx, d)) + 1n;
          const rows = await tx.$queryRaw<{ wallet: string; token: string; balance: string }[]>`
            SELECT COALESCE(u."wallet_address", p."wallet_address") AS "wallet",
                   a."chain_token_address" AS "token",
                   SUM(la."balance")::text AS "balance"
              FROM "ledger_accounts" la
              JOIN "assets" a ON a."id" = la."asset_id"
              JOIN "users" u ON u."id" = la."owner_user_id"
              -- Sub-accounts belong to their parent's wallet leaf (ADR-0017).
              LEFT JOIN "users" p ON p."id" = u."parent_user_id"
             WHERE a."chain_token_address" = ANY(${tokens}::text[])
               AND NOT u."is_vault"
               AND COALESCE(u."wallet_address", p."wallet_address") IS NOT NULL
               AND la."type" IN ('USER_AVAILABLE', 'USER_LOCKED', 'USER_MARGIN')
             GROUP BY 1, 2 HAVING SUM(la."balance") > 0`;
          const last = await tx.chainDeposit.aggregate({
            where: { chainId: d.chainId, vaultAddress: d.vaultAddress },
            _max: { depositId: true },
          });
          // Leader vaults (ADR-0019): a vault's balances belong to its share
          // holders pro rata (queued redemptions included), never to the leader.
          const vaultBalances = await tx.$queryRaw<
            { vault_id: string; token: string; balance: string }[]
          >`
            SELECT lv."id" AS "vault_id", a."chain_token_address" AS "token",
                   SUM(la."balance")::text AS "balance"
              FROM "leader_vaults" lv
              JOIN "ledger_accounts" la ON la."owner_user_id" = lv."account_user_id"
              JOIN "assets" a ON a."id" = la."asset_id"
             WHERE a."chain_token_address" = ANY(${tokens}::text[])
               AND la."type" IN ('USER_AVAILABLE', 'USER_LOCKED', 'USER_MARGIN')
             GROUP BY 1, 2 HAVING SUM(la."balance") > 0`;
          const holders = await tx.$queryRaw<
            { vault_id: string; wallet: string; shares: string }[]
          >`
            SELECT h."vault_id", u."wallet_address" AS "wallet", SUM(h."shares")::text AS "shares"
              FROM (SELECT "vault_id", "user_id", "shares" FROM "vault_shares"
                    UNION ALL
                    SELECT "vault_id", "user_id", "shares" FROM "vault_redemptions" WHERE "status" = 'PENDING') h
              JOIN "users" u ON u."id" = h."user_id"
             WHERE u."wallet_address" IS NOT NULL
             GROUP BY 1, 2 HAVING SUM(h."shares") > 0`;
          const merged = new Map<string, bigint>();
          for (const r of rows) merged.set(`${r.wallet}|${r.token}`, BigInt(r.balance));
          for (const vb of vaultBalances) {
            const hs = holders.filter((h) => h.vault_id === vb.vault_id);
            const total = hs.reduce((a, h) => a + BigInt(h.shares), 0n);
            if (total === 0n) continue;
            for (const h of hs) {
              const part = (BigInt(vb.balance) * BigInt(h.shares)) / total; // dust stays unclaimed
              if (part === 0n) continue;
              const k = `${h.wallet}|${vb.token}`;
              merged.set(k, (merged.get(k) ?? 0n) + part);
            }
          }
          const leaves: BalanceLeaf[] = [...merged].map(([k, balance]) => {
            const [wallet, token] = k.split('|') as [string, string];
            return { wallet: wallet as Hex, token: token as Hex, balance };
          });
          const { root } = buildTree(leaves);
          const created = await tx.vaultState.create({
            data: {
              chainId: d.chainId,
              vaultAddress: d.vaultAddress,
              index,
              root,
              lastDepositId: last._max.depositId ?? 0n,
              leafCount: leaves.length,
            },
          });
          if (leaves.length > 0) {
            await tx.vaultStateLeaf.createMany({
              data: leaves.map((l) => ({
                chainId: d.chainId,
                vaultAddress: d.vaultAddress,
                index,
                walletAddress: l.wallet,
                tokenAddress: l.token,
                balance: l.balance.toString(),
              })),
            });
          }
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 },
      );
    }
    const onChainIndex = (await this.rpc().readContract({
      address: d.vaultAddress as Hex,
      abi: VAULT_ABI as never,
      functionName: 'stateIndex',
    })) as bigint;
    let txHash: string | null = null;
    if (onChainIndex < state.index) {
      txHash = await this.operator().commitState(
        d.vaultAddress as Hex,
        state.index,
        state.root as Hex,
        state.lastDepositId,
      );
    }
    await this.prisma.vaultState.update({
      where: {
        chainId_vaultAddress_index: {
          chainId: d.chainId,
          vaultAddress: d.vaultAddress,
          index: state.index,
        },
      },
      data: { status: 'COMMITTED', committedAt: new Date(), txHash },
    });
    return state.index;
  }

  async proof(userId: string): Promise<VaultProofDto> {
    const d = await this.requireDeployment();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const state = await this.prisma.vaultState.findFirst({
      where: { chainId: d.chainId, vaultAddress: d.vaultAddress, status: 'COMMITTED' },
      orderBy: { index: 'desc' },
      include: { leaves: true },
    });
    const unexecuted = await this.prisma.withdrawal.findMany({
      where: { userId, vaultAddress: d.vaultAddress, status: { not: 'EXECUTED' } },
      include: { asset: true },
      orderBy: { createdAt: 'asc' },
    });
    const unexecutedWithdrawals = unexecuted.map((w) => this.withdrawalDto(w, d).call);
    if (!state)
      return {
        stateIndex: null,
        root: null,
        lastDepositId: null,
        entries: [],
        unexecutedWithdrawals,
      };
    const leaves = state.leaves.map((l) => ({
      wallet: l.walletAddress as Hex,
      token: l.tokenAddress as Hex,
      balance: toMinorUnits(l.balance),
    }));
    const { levels } = buildTree(leaves);
    const mine = leaves.filter((l) => l.wallet === user.walletAddress);
    const assets = await this.vaultAssets(d);
    return {
      stateIndex: state.index.toString(),
      root: state.root,
      lastDepositId: state.lastDepositId.toString(),
      entries: mine.map((l) => {
        const asset = assets.find((a) => a.chainTokenAddress === l.token);
        return {
          asset: asset?.code ?? l.token,
          token: getAddress(l.token),
          balance: l.balance.toString(),
          balanceFormatted: asset ? formatAmount(l.balance, asset.scale) : l.balance.toString(),
          proof: proofFor(levels, leafHash(l)) ?? [],
        };
      }),
      unexecutedWithdrawals,
    };
  }

  // ------------------------------------------------------ reconciliation

  /** Ledger custody vs. the vault's on-chain token balances at the indexed block. */
  async custodyCheck(): Promise<
    { asset: string; ledger: string; onChain: string; ok: boolean; atBlock: string }[]
  > {
    const d = await this.deployment();
    if (!d) return [];
    const cursor = await this.prisma.chainCursor.findUniqueOrThrow({
      where: { chainId: d.chainId },
    });
    const assets = await this.vaultAssets(d);
    const out = [];
    for (const a of assets) {
      const onChain = (await this.rpc().readContract({
        address: a.chainTokenAddress as Hex,
        abi: TOKEN_ABI as never,
        functionName: 'balanceOf',
        args: [d.vaultAddress as Hex] as never,
        blockNumber: cursor.lastBlock,
      })) as bigint;
      const acc = await this.prisma.ledgerAccount.findFirst({
        where: { assetId: a.id, type: 'VAULT_CUSTODY' },
      });
      const ledger = acc ? toMinorUnits(acc.balance) : 0n;
      out.push({
        asset: a.code,
        ledger: ledger.toString(),
        onChain: onChain.toString(),
        ok: ledger === onChain,
        atBlock: cursor.lastBlock.toString(),
      });
    }
    return out;
  }

  /**
   * Public proof of liabilities (ADR-0020): per vault token, what the
   * latest committed balance root promises to users (sum of its leaves),
   * what the ledger owes users now, and what the vault contract actually
   * holds now. Anyone can recompute the on-chain number.
   */
  async solvency() {
    const d = await this.deployment();
    if (!d) return { enabled: false as const };
    const state = await this.prisma.vaultState.findFirst({
      where: { chainId: d.chainId, vaultAddress: d.vaultAddress, status: 'COMMITTED' },
      orderBy: { index: 'desc' },
    });
    const assets = await this.vaultAssets(d);
    const tokens = [];
    for (const a of assets) {
      const onChain = (await this.rpc().readContract({
        address: a.chainTokenAddress as Hex,
        abi: TOKEN_ABI as never,
        functionName: 'balanceOf',
        args: [d.vaultAddress as Hex] as never,
      })) as bigint;
      const committed = state
        ? await this.prisma.vaultStateLeaf.aggregate({
            where: {
              chainId: d.chainId,
              vaultAddress: d.vaultAddress,
              index: state.index,
              tokenAddress: a.chainTokenAddress!,
            },
            _sum: { balance: true },
          })
        : null;
      const users = await this.prisma.ledgerAccount.aggregate({
        where: {
          assetId: a.id,
          type: { in: ['USER_AVAILABLE', 'USER_LOCKED', 'USER_MARGIN', 'USER_WITHDRAWING'] },
        },
        _sum: { balance: true },
      });
      const custody = await this.prisma.ledgerAccount.findFirst({
        where: { assetId: a.id, type: 'VAULT_CUSTODY' },
      });
      const fmt = (v: bigint) => formatAmountTrimmed(v, a.scale);
      const committedSum = committed?._sum.balance ? toMinorUnits(committed._sum.balance) : 0n;
      const owed = users._sum.balance ? toMinorUnits(users._sum.balance) : 0n;
      const custodyLedger = custody ? toMinorUnits(custody.balance) : 0n;
      tokens.push({
        asset: a.code,
        token: a.chainTokenAddress,
        onChainBalance: fmt(onChain),
        custodyLedger: fmt(custodyLedger),
        userBalancesNow: fmt(owed),
        committedLiabilities: fmt(committedSum),
        ledgerMatchesChain: custodyLedger === onChain,
        committedCovered: onChain >= committedSum,
      });
    }
    return {
      enabled: true as const,
      chainId: d.chainId,
      vault: d.vaultAddress,
      state: state
        ? {
            index: state.index.toString(),
            root: state.root,
            leafCount: state.leafCount,
            committedAt: state.committedAt?.toISOString() ?? null,
            txHash: state.txHash,
          }
        : null,
      tokens,
      notes: [
        'onChainBalance is read from the token contract at request time; anyone can verify it.',
        'committedLiabilities is the sum of every balance in the latest committed Merkle root, which users can claim through the escape hatch.',
        'Deposits and withdrawals after the committed state make the two differ temporarily.',
      ],
    };
  }

  // ----------------------------------------------------------- config/faucet

  async publicConfig(): Promise<VaultConfigDto> {
    const d = await this.deployment();
    if (!d)
      return {
        enabled: false,
        chainId: null,
        vault: null,
        tokens: [],
        freezeDelaySeconds: null,
        testnet: true,
      };
    const assets = await this.vaultAssets(d);
    const delay = (await this.rpc().readContract({
      address: d.vaultAddress as Hex,
      abi: VAULT_ABI as never,
      functionName: 'freezeDelay',
    })) as bigint;
    return {
      enabled: true,
      chainId: d.chainId,
      vault: getAddress(d.vaultAddress),
      tokens: assets.map((a) => ({
        asset: a.code,
        address: getAddress(a.chainTokenAddress!),
        decimals: a.scale,
      })),
      freezeDelaySeconds: Number(delay),
      testnet: true,
      faucet: this.config.CHAIN_FAUCET_ENABLED && d.chainId === 31337,
    };
  }

  /** Local chain only: gas and test tokens for a wallet account. */
  async faucet(userId: string): Promise<{ tokens: string[] }> {
    if (!this.config.CHAIN_FAUCET_ENABLED) throw AppError.notFound('Faucet disabled');
    const d = await this.requireDeployment();
    if (d.chainId !== 31337) throw conflict('The faucet only runs on the local chain');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.walletAddress) throw conflict('Sign in with a wallet first');
    const wallet = getAddress(user.walletAddress);
    await this.rpc().request({
      method: 'anvil_setBalance' as never,
      params: [wallet, '0xDE0B6B3A7640000'] as never, // 1 test ETH for gas
    });
    const assets = await this.vaultAssets(d);
    for (const a of assets) {
      await this.send(a.chainTokenAddress as Hex, TOKEN_ABI, 'mint', [
        wallet,
        10n ** BigInt(a.scale) * 1000n,
      ]);
    }
    return { tokens: assets.map((a) => a.code) };
  }
}
