'use client';

import type { VaultProofDto } from '@platform/shared';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import type { Dictionary } from '@/i18n';
import { api } from '@/lib/api';

interface Solvency {
  enabled: boolean;
  chainId?: number;
  vault?: string;
  state?: {
    index: string;
    root: string;
    leafCount: number;
    committedAt: string | null;
    txHash: string | null;
  } | null;
  tokens?: {
    asset: string;
    token: string;
    onChainBalance: string;
    custodyLedger: string;
    userBalancesNow: string;
    committedLiabilities: string;
    ledgerMatchesChain: boolean;
    committedCovered: boolean;
  }[];
  notes?: string[];
}

/** Public proof of liabilities and, when signed in, the user's own Merkle proof. */
export function ProofPage({ t }: { t: Dictionary }) {
  const p = t.proof;
  const [s, setS] = useState<Solvency | null>(null);
  const [mine, setMine] = useState<VaultProofDto | null>(null);
  useEffect(() => {
    api<Solvency>('/v1/vault/solvency')
      .then(setS)
      .catch(() => setS({ enabled: false }));
    api<VaultProofDto>('/v1/vault/proof')
      .then(setMine)
      .catch(() => setMine(null));
  }, []);
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-12 sm:px-6" data-testid="proof-page">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{p.title}</h1>
        <p className="mt-2 text-sm text-muted">{p.intro}</p>
      </div>
      {!s?.enabled ? (
        <Card className="p-6 text-sm text-muted">{p.disabled}</Card>
      ) : (
        <>
          <Card className="p-6">
            <CardTitle>{p.contract}</CardTitle>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted">{p.vault}</dt>
                <dd className="break-all font-mono text-xs">{s.vault}</dd>
              </div>
              <div>
                <dt className="text-muted">{p.chain}</dt>
                <dd className="font-mono">{s.chainId}</dd>
              </div>
              <div>
                <dt className="text-muted">{p.state}</dt>
                <dd className="font-mono text-xs">
                  {s.state ? `#${s.state.index} · ${s.state.leafCount} ${p.balances}` : p.noState}
                </dd>
              </div>
              <div>
                <dt className="text-muted">{p.root}</dt>
                <dd className="break-all font-mono text-xs">{s.state?.root ?? '—'}</dd>
              </div>
            </dl>
          </Card>
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  {[p.asset, p.onChain, p.committed, p.userNow, p.status].map((h) => (
                    <th key={h} className="px-4 py-3 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.tokens?.map((x) => (
                  <tr key={x.asset} className="border-t border-border" data-testid="solvency-row">
                    <td className="px-4 py-3">{x.asset}</td>
                    <td className="font-mono">{x.onChainBalance}</td>
                    <td className="font-mono">{x.committedLiabilities}</td>
                    <td className="font-mono">{x.userBalancesNow}</td>
                    <td>
                      <Badge
                        tone={x.committedCovered && x.ledgerMatchesChain ? 'positive' : 'warning'}
                      >
                        {x.committedCovered && x.ledgerMatchesChain ? p.covered : p.check}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <ul className="list-disc space-y-1 ps-5 text-xs text-muted">
            {s.notes?.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
      <Card className="p-6">
        <CardTitle>{p.mine}</CardTitle>
        <CardDescription>{p.mineIntro}</CardDescription>
        {mine?.entries.length ? (
          <ul className="mt-3 space-y-3 text-sm">
            {mine.entries.map((e) => (
              <li key={e.token}>
                <div>
                  {e.balanceFormatted} {e.asset} · {p.state} #{mine.stateIndex}
                </div>
                <pre className="mt-1 overflow-x-auto rounded bg-surface p-2 text-[11px]">
                  {JSON.stringify(e.proof, null, 1)}
                </pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">{p.noMine}</p>
        )}
      </Card>
    </div>
  );
}
