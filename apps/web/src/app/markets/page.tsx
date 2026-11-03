import type { Metadata } from 'next';
import { MarketsTable } from '@/components/trading/markets-table';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.terminal.marketsTitle };

export default function MarketsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">{t.terminal.marketsTitle}</h1>
      <p className="mt-2 text-muted">{t.terminal.marketsIntro}</p>
      <div className="mt-8">
        <MarketsTable t={t.terminal} />
      </div>
    </div>
  );
}
