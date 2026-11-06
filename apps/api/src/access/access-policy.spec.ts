import {
  countryFrom,
  decide,
  locationFrom,
  isReduceOnlyBody,
  normaliseAddress,
  regionRestricted,
  type AccessKind,
} from './access-policy';

const geo = {
  GEO_COUNTRY_HEADER: 'cf-ipcountry',
  GEO_REGION_HEADER: 'cf-region-code',
  GEO_UNKNOWN_COUNTRY: 'deny' as const,
  RESTRICTED_COUNTRIES: ['US', 'KP'],
  RESTRICTED_SUBDIVISIONS: ['CA-ON', 'UA-43'],
};
const at = (country: string | null, subdivision: string | null = null) => ({
  country,
  subdivision,
});

describe('countryFrom', () => {
  it('reads a valid code from the configured header', () => {
    expect(countryFrom({ 'cf-ipcountry': 'de' }, geo)).toBe('DE');
  });
  it('treats missing, repeated, malformed and anonymiser codes as unknown', () => {
    expect(countryFrom({}, geo)).toBeNull();
    expect(countryFrom({ 'cf-ipcountry': ['DE', 'US'] }, geo)).toBeNull();
    expect(countryFrom({ 'cf-ipcountry': 'USA' }, geo)).toBeNull();
    expect(countryFrom({ 'cf-ipcountry': 'T1' }, geo)).toBeNull();
    expect(countryFrom({ 'cf-ipcountry': 'XX' }, geo)).toBeNull();
  });
  it('is off without a configured header', () => {
    expect(countryFrom({ 'cf-ipcountry': 'US' }, { GEO_COUNTRY_HEADER: '' })).toBeNull();
  });
});

describe('locationFrom', () => {
  it('reads the subdivision in bare or full ISO 3166-2 form', () => {
    expect(locationFrom({ 'cf-ipcountry': 'CA', 'cf-region-code': 'on' }, geo)).toEqual(
      at('CA', 'CA-ON'),
    );
    expect(locationFrom({ 'cf-ipcountry': 'CA', 'cf-region-code': 'CA-QC' }, geo)).toEqual(
      at('CA', 'CA-QC'),
    );
  });
  it('treats a mismatched, malformed or repeated subdivision as unknown', () => {
    expect(locationFrom({ 'cf-ipcountry': 'CA', 'cf-region-code': 'US-NY' }, geo)).toEqual(
      at('CA'),
    );
    expect(locationFrom({ 'cf-ipcountry': 'CA', 'cf-region-code': 'Ontario' }, geo)).toEqual(
      at('CA'),
    );
    expect(locationFrom({ 'cf-ipcountry': 'CA', 'cf-region-code': ['ON', 'QC'] }, geo)).toEqual(
      at('CA'),
    );
    expect(locationFrom({ 'cf-region-code': 'ON' }, geo)).toEqual(at(null));
    expect(
      locationFrom(
        { 'cf-ipcountry': 'CA', 'cf-region-code': 'ON' },
        { ...geo, GEO_REGION_HEADER: '' },
      ),
    ).toEqual(at('CA'));
  });
});

describe('regionRestricted', () => {
  it('blocks listed countries and, when configured, unknown ones', () => {
    expect(regionRestricted(at('US'), geo)).toBe(true);
    expect(regionRestricted(at('DE'), geo)).toBe(false);
    expect(regionRestricted(at(null), geo)).toBe(true);
    expect(regionRestricted(at(null), { ...geo, GEO_UNKNOWN_COUNTRY: 'allow' })).toBe(false);
  });
  it('blocks listed subdivisions only, and needs a known subdivision in such a country', () => {
    expect(regionRestricted(at('CA', 'CA-ON'), geo)).toBe(true);
    expect(regionRestricted(at('CA', 'CA-QC'), geo)).toBe(false);
    expect(regionRestricted(at('UA', 'UA-43'), geo)).toBe(true);
    expect(regionRestricted(at('UA', 'UA-30'), geo)).toBe(false);
    expect(regionRestricted(at('CA'), geo)).toBe(true);
    expect(regionRestricted(at('CA'), { ...geo, GEO_UNKNOWN_COUNTRY: 'allow' })).toBe(false);
    // Countries without restricted subdivisions do not need one.
    expect(regionRestricted(at('DE'), geo)).toBe(false);
  });
  it('is off without a header (local/ci)', () => {
    expect(regionRestricted(at('US'), { ...geo, GEO_COUNTRY_HEADER: '' })).toBe(false);
  });
});

describe('isReduceOnlyBody', () => {
  it('recognises single and batch reduce-only bodies', () => {
    expect(isReduceOnlyBody('single', { reduceOnly: true })).toBe(true);
    expect(isReduceOnlyBody('single', { reduceOnly: 'true' })).toBe(false);
    expect(
      isReduceOnlyBody('batch', { orders: [{ reduceOnly: true }, { reduceOnly: true }] }),
    ).toBe(true);
    expect(isReduceOnlyBody('batch', { orders: [{ reduceOnly: true }, {}] })).toBe(false);
    expect(isReduceOnlyBody('batch', { orders: [] })).toBe(false);
    expect(isReduceOnlyBody(undefined, { reduceOnly: true })).toBe(false);
  });
});

describe('decide', () => {
  const kinds: AccessKind[] = ['open', 'manage', 'withdraw'];
  const bools = [false, true];

  it('matches the policy table for every combination', () => {
    for (const kind of kinds)
      for (const regionRestricted of bools)
        for (const reduceOnly of bools)
          for (const sanctioned of bools)
            for (const termsAccepted of bools) {
              const d = decide(kind, { regionRestricted, reduceOnly, sanctioned, termsAccepted });
              let expected: string | null = null;
              if (sanctioned) expected = 'SANCTIONED_ADDRESS';
              else if (kind === 'open' && regionRestricted && !reduceOnly)
                expected = 'REGION_RESTRICTED';
              else if (kind !== 'withdraw' && !termsAccepted) expected = 'TERMS_NOT_ACCEPTED';
              expect(d.allow ? null : d.code).toBe(expected);
            }
  });

  it('never blocks a withdrawal for region or terms', () => {
    expect(
      decide('withdraw', {
        regionRestricted: true,
        reduceOnly: false,
        sanctioned: false,
        termsAccepted: false,
      }),
    ).toEqual({ allow: true });
  });
});

describe('normaliseAddress', () => {
  it('accepts addresses in any case and rejects anything else', () => {
    expect(normaliseAddress(' 0xAbCdEf0000000000000000000000000000000001 ')).toBe(
      '0xabcdef0000000000000000000000000000000001',
    );
    expect(normaliseAddress('0x123')).toBeNull();
    expect(normaliseAddress('# comment')).toBeNull();
  });
});
