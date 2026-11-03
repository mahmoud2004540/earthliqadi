import { describe, expect, it } from 'vitest';
import { en } from './en';

describe('dictionary', () => {
  it('has no empty strings', () => {
    const empty = (obj: unknown): boolean =>
      typeof obj === 'string'
        ? obj.trim() === ''
        : obj && typeof obj === 'object'
          ? Object.values(obj).some(empty)
          : false;
    expect(empty(en)).toBe(false);
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

  it('marks every roadmap phase as available or planned', () => {
    expect(en.home.phases.every((p) => p.status === 'available' || p.status === 'planned')).toBe(
      true,
    );
  });
});
