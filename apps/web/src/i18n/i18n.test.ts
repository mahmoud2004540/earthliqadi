import { describe, expect, it } from 'vitest';
import { ar } from './ar';
import { en } from './en';
import { negotiateLocale } from './index';

function shape(value: unknown, path = ''): string[] {
  if (Array.isArray(value))
    return [`${path}[${value.length}]`, ...value.flatMap((v, i) => shape(v, `${path}[${i}]`))];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
  }
  return [path];
}

describe('dictionaries', () => {
  it('Arabic has exactly the same keys and list lengths as English', () => {
    expect(shape(ar)).toEqual(shape(en));
  });

  it('has no empty strings', () => {
    const empty = (obj: unknown): boolean =>
      typeof obj === 'string'
        ? obj.trim() === ''
        : obj && typeof obj === 'object'
          ? Object.values(obj).some(empty)
          : false;
    expect(empty(en)).toBe(false);
    expect(empty(ar)).toBe(false);
  });

  it('never claims licensing, audits, insurance or partnerships as facts', () => {
    const text = JSON.stringify(en).toLowerCase();
    for (const claim of [
      'we are licensed',
      'fully licensed',
      'insured',
      'audited by',
      'partnered with',
      'guaranteed',
    ]) {
      expect(text).not.toContain(claim);
    }
  });
});

describe('negotiateLocale', () => {
  it.each([
    [undefined, 'en'],
    ['ar-EG,ar;q=0.9,en;q=0.8', 'ar'],
    ['fr-FR,fr;q=0.9,en;q=0.5', 'en'],
    ['en;q=0.2,ar;q=0.8', 'ar'],
    ['de', 'en'],
    ['ar;q=0', 'en'],
  ])('%s → %s', (header, expected) => {
    expect(negotiateLocale(header)).toBe(expected);
  });
});
