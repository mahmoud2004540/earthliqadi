import { CheckCircle2, Circle, Eye, LineChart, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { getDictionary } from '@/i18n';

const PILLAR_ICONS = [ShieldCheck, Eye, LineChart];

export default function HomePage() {
  const t = getDictionary();
  return (
    <>
      <section className="relative overflow-hidden border-b border-border">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(57,120,246,0.18),transparent_60%)]"
        />
        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
          <Badge tone="warning">{t.home.eyebrow}</Badge>
          <h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
            {t.home.title}
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">{t.home.subtitle}</p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={'/connect'}>{t.home.ctaPrimary}</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={'/trust'}>{t.home.ctaSecondary}</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-4 px-4 py-16 sm:px-6 md:grid-cols-3">
        {t.home.pillars.map((pillar, i) => {
          const Icon = PILLAR_ICONS[i] ?? ShieldCheck;
          return (
            <Card key={pillar.title}>
              <Icon aria-hidden className="size-6 text-primary" />
              <CardTitle className="mt-4">{pillar.title}</CardTitle>
              <CardDescription>{pillar.body}</CardDescription>
            </Card>
          );
        })}
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">{t.home.roadmapTitle}</h2>
        <p className="mt-2 max-w-2xl text-muted">{t.home.roadmapIntro}</p>
        <ol className="mt-8 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {t.home.phases.map((phase, i) => {
            const done = phase.status === 'available';
            return (
              <li
                key={phase.name}
                className="flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3"
              >
                {done ? (
                  <CheckCircle2 aria-hidden className="size-5 shrink-0 text-positive" />
                ) : (
                  <Circle aria-hidden className="size-5 shrink-0 text-muted" />
                )}
                <span className="text-sm">
                  <span className="text-muted">
                    {t.status.phase} {i}
                  </span>{' '}
                  · {phase.name}
                </span>
                <Badge tone={done ? 'positive' : 'neutral'} className="ms-auto shrink-0">
                  {done ? t.status.available : t.status.planned}
                </Badge>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
