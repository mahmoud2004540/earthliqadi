import { scrubMetadata } from './audit.service';

describe('scrubMetadata', () => {
  it('redacts keys that look sensitive', () => {
    expect(
      scrubMetadata({
        reason: 'bad_password',
        password: 'x',
        resetToken: 'y',
        totpCode: '123456',
        count: 2,
      }),
    ).toEqual({
      reason: 'bad_password',
      password: '[REDACTED]',
      resetToken: '[REDACTED]',
      totpCode: '[REDACTED]',
      count: 2,
    });
  });
});
