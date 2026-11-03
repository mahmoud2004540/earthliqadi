import { DEFAULT_LOCALE, LOCALES, directionFor, isLocale, type Locale } from '@platform/shared';
import { ar } from './ar';
import { en, type Dictionary } from './en';

const dictionaries: Record<Locale, Dictionary> = { en, ar };

export { DEFAULT_LOCALE, LOCALES, directionFor, isLocale, type Dictionary, type Locale };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

/** Picks the best supported locale from an Accept-Language header. */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { lang: tag.toLowerCase().split('-')[0] ?? '', q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((entry) => entry.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { lang } of ranked) {
    if (isLocale(lang)) return lang;
  }
  return DEFAULT_LOCALE;
}
