import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { verifyRequest } from './hmac';
import { PolicyError, SigningPolicy, type PolicyConfig } from './policy';

export interface SignerConfig {
  operatorKey: Hex;
  hmacSecret: string;
  rpcUrl: string;
  policy: PolicyConfig;
  auditFile: string;
  minCommitIntervalSeconds: number;
  /** Chain clock in seconds (default: latest block timestamp over RPC). Fails closed. */
  chainTime?: () => Promise<bigint>;
}

const VAULT_ABI = parseAbi([
  'function commitState(uint64 index, bytes32 root, uint64 lastDepositId)',
  'function stateIndex() view returns (uint64)',
  'function setDepositCap(address token, uint256 cap)',
]);

const depositCapSchema = z.object({
  vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  cap: z.string().regex(/^\d{1,78}$/),
});

const withdrawalSchema = z.object({
  chainId: z.number().int(),
  vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  withdrawal: z.object({
    id: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    user: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    amount: z.string().regex(/^\d{1,78}$/),
    afterState: z.string().regex(/^\d{1,20}$/),
    expiry: z.string().regex(/^\d{1,20}$/),
  }),
});

const commitSchema = z.object({
  vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  index: z.string().regex(/^\d{1,20}$/),
  root: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  lastDepositId: z.string().regex(/^\d{1,20}$/),
});

/**
 * Isolated operator signer (ADR-0015). Holds the vault operator key; the API
 * asks it to sign withdrawals and commit state roots over an authenticated
 * channel, and every request is checked against a local policy and written to
 * an append-only audit log (also the source of truth for daily limits after a
 * restart). It exposes nothing else: no generic "sign arbitrary data".
 */
export function createSignerServer(
  config: SignerConfig,
  clock: () => Date = () => new Date(),
): Server {
  const account = privateKeyToAccount(config.operatorKey);
  const policy = new SigningPolicy(config.policy);
  const seenRequests = new Map<string, number>();
  let lastCommitAt = 0;

  if (existsSync(config.auditFile)) {
    for (const line of readFileSync(config.auditFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as {
        kind: string;
        id?: string;
        token?: string;
        amount?: string;
        at: string;
      };
      if (e.kind === 'withdrawal.signed' && e.id && e.token && e.amount)
        policy.replay({ id: e.id, token: e.token, amount: BigInt(e.amount), at: new Date(e.at) });
    }
  }
  const audit = (entry: Record<string, unknown>): void => {
    appendFileSync(
      config.auditFile,
      `${JSON.stringify({ ...entry, at: clock().toISOString() })}\n`,
    );
  };

  const client = createPublicClient({ transport: http(config.rpcUrl), cacheTime: 0 });
  const chainTime = config.chainTime ?? (async () => (await client.getBlock()).timestamp);
  const wallet = createWalletClient({ account, transport: http(config.rpcUrl) });

  async function handle(
    req: IncomingMessage,
    body: string,
  ): Promise<{ status: number; json: unknown }> {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/health') return { status: 200, json: { ok: true } };

    const now = clock();
    const headers = {
      timestamp: req.headers['x-signer-timestamp'] as string | undefined,
      requestId: req.headers['x-signer-request-id'] as string | undefined,
      signature: req.headers['x-signer-signature'] as string | undefined,
    };
    const auth = verifyRequest(config.hmacSecret, headers, body, now);
    if (auth !== 'ok') {
      audit({ kind: 'auth.rejected', reason: auth, path: url });
      return { status: 401, json: { error: 'unauthenticated' } };
    }
    for (const [id, t] of seenRequests) if (now.getTime() - t > 60_000) seenRequests.delete(id);
    if (seenRequests.has(headers.requestId!)) {
      audit({ kind: 'auth.replay', path: url });
      return { status: 401, json: { error: 'replayed request' } };
    }
    seenRequests.set(headers.requestId!, now.getTime());

    if (req.method === 'GET' && url === '/v1/address')
      return { status: 200, json: { address: account.address } };

    if (req.method === 'POST' && url === '/v1/sign/withdrawal') {
      const parsed = withdrawalSchema.safeParse(JSON.parse(body || '{}'));
      if (!parsed.success) return { status: 400, json: { error: 'invalid request' } };
      const { chainId, vault, withdrawal: w } = parsed.data;
      const request = {
        chainId,
        vault,
        id: w.id,
        user: w.user,
        token: w.token,
        amount: BigInt(w.amount),
        afterState: BigInt(w.afterState),
        expiry: BigInt(w.expiry),
      };
      try {
        policy.check(request, now, await chainTime());
      } catch (err) {
        if (!(err instanceof PolicyError)) throw err;
        audit({
          kind: 'withdrawal.refused',
          code: err.code,
          id: w.id,
          token: w.token,
          amount: w.amount,
        });
        return { status: 403, json: { error: err.code, message: err.message } };
      }
      const signature = await account.signTypedData({
        domain: {
          name: 'ExchangeVault',
          version: '1',
          chainId,
          verifyingContract: getAddress(vault),
        },
        types: {
          Withdrawal: [
            { name: 'id', type: 'bytes32' },
            { name: 'user', type: 'address' },
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'afterState', type: 'uint64' },
            { name: 'expiry', type: 'uint64' },
          ],
        },
        primaryType: 'Withdrawal',
        message: {
          id: w.id as Hex,
          user: getAddress(w.user),
          token: getAddress(w.token),
          amount: request.amount,
          afterState: request.afterState,
          expiry: request.expiry,
        },
      });
      // Persist BEFORE answering: a crash can never forget a signature it handed out.
      audit({
        kind: 'withdrawal.signed',
        id: w.id,
        user: w.user,
        token: w.token,
        amount: w.amount,
      });
      policy.record(request, now);
      return { status: 200, json: { signature } };
    }

    if (req.method === 'POST' && url === '/v1/deposit-cap') {
      // Launch guard (ADR-0033): only limits new deposits, never moves funds.
      const parsed = depositCapSchema.safeParse(JSON.parse(body || '{}'));
      if (!parsed.success) return { status: 400, json: { error: 'invalid request' } };
      const c = parsed.data;
      if (BigInt(c.cap) >= 2n ** 256n) return { status: 400, json: { error: 'invalid request' } };
      if (c.vault.toLowerCase() !== config.policy.vault)
        return { status: 403, json: { error: 'WRONG_VAULT' } };
      const hash = await wallet.writeContract({
        address: getAddress(c.vault),
        abi: VAULT_ABI,
        functionName: 'setDepositCap',
        args: [getAddress(c.token), BigInt(c.cap)],
        chain: null,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      audit({
        kind: 'deposit_cap.set',
        token: c.token,
        cap: c.cap,
        tx: hash,
        status: receipt.status,
      });
      return {
        status: receipt.status === 'success' ? 200 : 502,
        json: { txHash: hash, status: receipt.status },
      };
    }

    if (req.method === 'POST' && url === '/v1/commit-state') {
      const parsed = commitSchema.safeParse(JSON.parse(body || '{}'));
      if (!parsed.success) return { status: 400, json: { error: 'invalid request' } };
      const c = parsed.data;
      if (c.vault.toLowerCase() !== config.policy.vault)
        return { status: 403, json: { error: 'WRONG_VAULT' } };
      if (now.getTime() - lastCommitAt < config.minCommitIntervalSeconds * 1000)
        return { status: 429, json: { error: 'COMMIT_RATE_LIMITED' } };
      const onChain = await client.readContract({
        address: getAddress(c.vault),
        abi: VAULT_ABI,
        functionName: 'stateIndex',
      });
      if (BigInt(c.index) !== onChain + 1n)
        return { status: 409, json: { error: 'NON_SEQUENTIAL_INDEX' } };
      const hash = await wallet.writeContract({
        address: getAddress(c.vault),
        abi: VAULT_ABI,
        functionName: 'commitState',
        args: [BigInt(c.index), c.root as Hex, BigInt(c.lastDepositId)],
        chain: null,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      lastCommitAt = now.getTime();
      audit({
        kind: 'state.committed',
        index: c.index,
        root: c.root,
        tx: hash,
        status: receipt.status,
      });
      return {
        status: receipt.status === 'success' ? 200 : 502,
        json: { txHash: hash, status: receipt.status },
      };
    }
    return { status: 404, json: { error: 'not found' } };
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      handle(req, Buffer.concat(chunks).toString('utf8'))
        .then(({ status, json }) => {
          res.writeHead(status, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify(json));
        })
        .catch(() => {
          // Never echo internals to the caller.
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        });
    });
  });
}
