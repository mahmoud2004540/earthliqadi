import { marketSymbolSchema } from '@platform/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Terminal } from '@/components/trading/terminal';
import { getDictionary } from '@/i18n';

const t = getDictionary();

type Props = { params: Promise<{ symbol: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { symbol } = await params;
  return { title: `${decodeURIComponent(symbol).toUpperCase()} · ${t.terminal.trade}` };
}

export default async function TradePage({ params }: Props) {
  const parsed = marketSymbolSchema.safeParse(decodeURIComponent((await params).symbol));
  if (!parsed.success) notFound();
  return <Terminal symbol={parsed.data} t={t} />;
}
