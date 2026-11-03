import { loginSchema } from '@platform/shared';
import { AppError } from './app-error';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(loginSchema);

  it('returns parsed, normalised data', () => {
    expect(pipe.transform({ email: 'A@B.CO', password: 'x' })).toEqual({
      email: 'a@b.co',
      password: 'x',
    });
  });

  it('throws a VALIDATION_FAILED AppError with field details', () => {
    try {
      pipe.transform({ email: 'nope' });
      fail('expected error');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('VALIDATION_FAILED');
      expect(appErr.details?.map((d) => d.path)).toEqual(
        expect.arrayContaining(['email', 'password']),
      );
    }
  });

  it('strips unknown keys (no mass assignment)', () => {
    expect(pipe.transform({ email: 'a@b.co', password: 'x', isAdmin: true })).not.toHaveProperty(
      'isAdmin',
    );
  });
});
