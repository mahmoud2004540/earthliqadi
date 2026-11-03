import { testConfig } from '../test-utils';
import { CsrfService } from './csrf.service';

describe('CsrfService', () => {
  const csrf = new CsrfService(testConfig());

  it('accepts a freshly issued token echoed in header and cookie', () => {
    const token = csrf.issue();
    expect(csrf.isValid(token, token)).toBe(true);
  });

  it('rejects when header and cookie differ', () => {
    expect(csrf.isValid(csrf.issue(), csrf.issue())).toBe(false);
  });

  it('rejects missing values', () => {
    const token = csrf.issue();
    expect(csrf.isValid(undefined, token)).toBe(false);
    expect(csrf.isValid(token, undefined)).toBe(false);
  });

  it('rejects forged tokens that were not signed with the server secret', () => {
    const forged = 'attacker-chosen-nonce.not-a-valid-signature';
    expect(csrf.isValid(forged, forged)).toBe(false);
  });

  it('rejects tokens signed with a different secret', () => {
    const other = new CsrfService(
      testConfig({ CSRF_SECRET: 'another-secret-another-secret-12345' }),
    );
    const token = other.issue();
    expect(csrf.isValid(token, token)).toBe(false);
  });
});
