import { z } from 'zod';

/**
 * Password policy (NIST SP 800-63B aligned): length-based, no composition
 * rules, upper bound to bound hashing cost. Breached-password screening is a
 * planned addition (see docs/security/threat-model.md).
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

/** Opaque URL-safe token (email verification, password reset, MFA challenge). */
export const opaqueTokenSchema = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid token format');

export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Code must be 6 digits');

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    locale: z.enum(['en', 'ar']).default('en'),
    acceptTerms: z.literal(true, { error: 'Terms must be accepted' }),
  })
  .refine((data) => !data.password.toLowerCase().includes(data.email.split('@')[0] ?? '\u0000'), {
    path: ['password'],
    message: 'Password must not contain your email name',
  });
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  // Do not apply length policy on login: legacy passwords must still be checkable.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.input<typeof loginSchema>;

export const loginMfaSchema = z.object({
  challengeId: opaqueTokenSchema,
  code: totpCodeSchema,
});

export const verifyEmailSchema = z.object({ token: opaqueTokenSchema });

export const emailOnlySchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: opaqueTokenSchema,
  newPassword: passwordSchema,
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .refine((d) => d.currentPassword !== d.newPassword, {
    path: ['newPassword'],
    message: 'New password must differ from the current password',
  });

export const totpSetupSchema = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
export const totpEnableSchema = z.object({ code: totpCodeSchema });
export const totpDisableSchema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  code: totpCodeSchema,
});

export const uuidParamSchema = z.object({ id: z.uuid() });

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});
