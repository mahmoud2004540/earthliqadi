import type { Metadata } from 'next';
import { InfoPage } from '@/components/info-page';
import { Badge } from '@/components/ui/badge';
import { getDictionary } from '@/i18n';

export const metadata: Metadata = { title: getDictionary().pages.trust.title };

/**
 * Trust Center structure. Every item is rendered as "not yet published" until
 * real, independently verifiable content exists. Do not add placeholder
 * claims, figures or logos here.
 */
export default function TrustPage() {
  const t = getDictionary();
  const { title, intro, items, itemNote } = t.pages.trust;
  return (
    <InfoPage title={title} intro={intro}>
      <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
        {items.map((item) => (
          <li key={item} className="flex flex-wrap items-center gap-3 px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{item}</p>
              <p className="text-sm text-muted">{itemNote}</p>
            </div>
            <Badge>{t.status.notPublished}</Badge>
          </li>
        ))}
      </ul>
    </InfoPage>
  );
}
