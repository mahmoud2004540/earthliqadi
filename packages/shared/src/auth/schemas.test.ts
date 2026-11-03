import { describe, expect, it } from 'vitest';
import { changePasswordSchema, loginSchema, registerSchema, totpCodeSchema } from './schemas';

describe('registerSchema', () => {
  const valid = {
    email: '  Alice@Example.COM ',
    password: 'correct horse battery staple',
    acceptTerms: true,
  };

  it('normalises email to trimmed lowercase and defaults locale', () => {
    const parsed = registerSchema.parse(valid);
    expect(parsed.email).toBe('alice@example.com');
    expect(parsed.locale).toBe('en');
  });

  it('rejects short passwords', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false);
  });

  it('rejects overly long passwords (bounds hashing cost)', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'x'.repeat(129) }).success).toBe(false);
  });

  it('rejects passwords containing the email local part', () => {
    const result = registerSchema.safeParse({ ...valid, password: 'my-alice-password-123' });
    expect(result.success).toBe(false);
  });

  it('requires accepting the terms', () => {
    expect(registerSchema.safeParse({ ...valid, acceptTerms: false }).success).toBe(false);
  });

  it('rejects invalid emails', () => {
    expect(registerSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('does not enforce the length policy on login', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(true);
  });
});

describe('changePasswordSchema', () => {
  it('rejects reusing the current password', () => {
    const pw = 'a-sufficiently-long-password';
    expect(changePasswordSchema.safeParse({ currentPassword: pw, newPassword: pw }).success).toBe(
      false,
    );
  });
});

describe('totpCodeSchema', () => {
  it.each(['123456', '000000'])('accepts %s', (code) => {
    expect(totpCodeSchema.safeParse(code).success).toBe(true);
  });
  it.each(['12345', '1234567', 'abcdef', '12 456'])('rejects %s', (code) => {
    expect(totpCodeSchema.safeParse(code).success).toBe(false);
  });
});
