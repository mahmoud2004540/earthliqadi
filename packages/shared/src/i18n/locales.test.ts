import { describe, expect, it } from 'vitest';
import { directionFor, isLocale } from './locales';

describe('locales', () => {
  it('maps Arabic to RTL and English to LTR', () => {
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('en')).toBe('ltr');
  });
  it('validates locale strings', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});
