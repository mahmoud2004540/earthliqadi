import type { Metadata } from 'next';
import { Leaderboard } from '@/components/growth/fee-schedule';
import { getDictionary } from '@/i18n';

const t = getDictionary();

export const metadata: Metadata = { title: t.growth.leaderboardTitle };

export default function Page() {
  return <Leaderboard t={t} />;
}
