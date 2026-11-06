'use client';

import type { AssetDto, ListingRequestDto } from '@platform/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import type { Dictionary } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/utils';

type Filter = 'live' | 'listed' | 'rejected';
type Msg = { tone: 'error' | 'success'; text: string } | null;

/**
 * Listing request board (ADR-0026): public requests ranked by votes from
 * accounts that traded, the published criteria, and every decision with its
 * reason. User text is rendered as plain text; links are never made clickable.
 */
export function ListingBoard({ t }: { t: Dictionary }) {
  const l = t.listings;
  const [filter, setFilter] = useState<Filter>('live');
  const [requests, setRequests] = useState<ListingRequestDto[] | null>(null);
  const [mine, setMine] = useState<{ authored: string[]; voted: string[] } | null>(null);
  const [assets, setAssets] = useState<AssetDto[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [form, setForm] = useState<Record<string, string>>({ kind: 'spot' });
  const set = (k: string) => (v: string) => setForm((p) => ({ ...p, [k]: v }));

  const load = useCallback(() => {
    api<{ requests: ListingRequestDto[] }>('/v1/listings')
      .then((r) => setRequests(r.requests))
      .catch(() => setRequests([]));
    api<{ authored: string[]; voted: string[] }>('/v1/listings/mine')
      .then(setMine)
      .catch(() => setMine(null));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ assets: AssetDto[] }>('/v1/assets')
      .then((r) => setAssets(r.assets))
      .catch(() => setAssets([]));
  }, []);

  const fail = (err: unknown) =>
    setMsg({
      tone: 'error',
      text:
        err instanceof ApiError
          ? err.status === 401
            ? l.signIn
            : (err.details?.[0]?.message ?? err.message)
          : String(err),
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('/v1/listings', {
        method: 'POST',
        body: {
          baseSymbol: form.baseSymbol ?? '',
          baseName: form.baseName ?? '',
          kind: form.kind,
          quoteAsset: form.quoteAsset ?? assets[0]?.code ?? '',
          rationale: form.rationale ?? '',
          ...(form.tokenAddress
            ? { tokenAddress: form.tokenAddress, chainId: Number(form.chainId) }
            : {}),
          ...(form.link ? { link: form.link } : {}),
        },
      });
      setMsg({ tone: 'success', text: l.submitted });
      setForm({ kind: 'spot' });
      setFilter('live');
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function act(path: string, method: 'POST' | 'DELETE') {
    setMsg(null);
    try {
      await api(path, { method, ...(method === 'POST' ? { body: {} } : {}) });
      load();
    } catch (err) {
      fail(err);
    }
  }

  const shown = (requests ?? []).filter((r) =>
    filter === 'live' ? r.status === 'open' || r.status === 'review' : r.status === filter,
  );

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-10 sm:px-6" data-testid="listing-board">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{l.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted">{l.intro}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <div role="tablist" className="flex gap-1 border-b border-border">
            {(Object.keys(l.filters) as Filter[]).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  '-mb-px border-b-2 px-4 py-2 text-sm font-medium',
                  filter === f
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted hover:text-foreground',
                )}
              >
                {l.filters[f]}
              </button>
            ))}
          </div>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          {requests && shown.length === 0 && <p className="text-sm text-muted">{l.empty}</p>}
          {shown.map((r) => {
            const voted = mine?.voted.includes(r.id) ?? false;
            const authored = mine?.authored.includes(r.id) ?? false;
            const live = r.status === 'open' || r.status === 'review';
            return (
              <Card key={r.id} className="p-5" data-testid="listing-row">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold">
                        {r.baseSymbol}/{r.quoteAsset}
                      </h2>
                      <Badge>{r.kind === 'spot' ? l.spot : l.perpetual}</Badge>
                      <Badge>{l.status[r.status]}</Badge>
                      {authored && <Badge>{l.yours}</Badge>}
                    </div>
                    <p className="text-sm text-muted">{r.baseName}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-semibold" data-testid="eligible-votes">
                      {r.eligibleVotes}
                    </p>
                    <p className="text-xs text-muted">
                      {l.votes} · {r.totalVotes} {l.totalVotes}
                    </p>
                  </div>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm">{r.rationale}</p>
                {(r.tokenAddress || r.link) && (
                  <p className="mt-2 break-all font-mono text-xs text-muted">
                    {r.tokenAddress && `chain ${r.chainId} · ${r.tokenAddress}`}
                    {r.tokenAddress && r.link && ' · '}
                    {r.link}
                  </p>
                )}
                {r.decisionNote && (
                  <p className="mt-3 rounded-md border border-border bg-surface-raised p-3 text-sm">
                    <strong>{l.decision}:</strong> {r.decisionNote}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  {live && (
                    <Button
                      size="sm"
                      variant={voted ? 'outline' : 'primary'}
                      onClick={() =>
                        void act(`/v1/listings/${r.id}/vote`, voted ? 'DELETE' : 'POST')
                      }
                      data-testid="vote"
                    >
                      {voted ? l.unvote : l.vote}
                    </Button>
                  )}
                  {authored && r.status === 'open' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void act(`/v1/listings/${r.id}/withdraw`, 'POST')}
                    >
                      {l.withdraw}
                    </Button>
                  )}
                  {r.market && (
                    <Button size="sm" asChild>
                      <Link href={`/trade/${r.market}`}>
                        {l.trade} {r.market}
                      </Link>
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <CardTitle>{l.formTitle}</CardTitle>
            <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="ls-symbol">{l.baseSymbol}</Label>
                  <Input
                    id="ls-symbol"
                    value={form.baseSymbol ?? ''}
                    onChange={(e) => set('baseSymbol')(e.target.value.toUpperCase().trim())}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="ls-name">{l.baseName}</Label>
                  <Input
                    id="ls-name"
                    value={form.baseName ?? ''}
                    onChange={(e) => set('baseName')(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="ls-kind">{l.kind}</Label>
                  <select
                    id="ls-kind"
                    className="h-10 w-full rounded-md border border-border bg-background px-2"
                    value={form.kind}
                    onChange={(e) => set('kind')(e.target.value)}
                  >
                    <option value="spot">{l.spot}</option>
                    <option value="perpetual">{l.perpetual}</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="ls-quote">{l.quoteAsset}</Label>
                  <select
                    id="ls-quote"
                    className="h-10 w-full rounded-md border border-border bg-background px-2"
                    value={form.quoteAsset ?? assets[0]?.code ?? ''}
                    onChange={(e) => set('quoteAsset')(e.target.value)}
                  >
                    {assets.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <Label htmlFor="ls-token">{l.tokenAddress}</Label>
                <Input
                  id="ls-token"
                  value={form.tokenAddress ?? ''}
                  onChange={(e) => set('tokenAddress')(e.target.value.trim())}
                  placeholder="0x…"
                  dir="ltr"
                />
              </div>
              {form.tokenAddress && (
                <div>
                  <Label htmlFor="ls-chain">{l.chainId}</Label>
                  <Input
                    id="ls-chain"
                    inputMode="numeric"
                    value={form.chainId ?? ''}
                    onChange={(e) => set('chainId')(e.target.value.replace(/[^0-9]/g, ''))}
                    required
                  />
                </div>
              )}
              <div>
                <Label htmlFor="ls-why">{l.rationale}</Label>
                <textarea
                  id="ls-why"
                  className="min-h-24 w-full rounded-md border border-border bg-background p-2"
                  maxLength={1000}
                  value={form.rationale ?? ''}
                  onChange={(e) => set('rationale')(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="ls-link">{l.link}</Label>
                <Input
                  id="ls-link"
                  value={form.link ?? ''}
                  onChange={(e) => set('link')(e.target.value.trim())}
                  placeholder="https://"
                  dir="ltr"
                />
              </div>
              <Button type="submit" className="w-full">
                {l.submit}
              </Button>
            </form>
          </Card>
          <Card className="p-5" data-testid="listing-criteria">
            <CardTitle>{l.criteriaTitle}</CardTitle>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted">
              {l.criteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-muted">{l.votesNote}</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
