import { Logger, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { AppError } from './app-error';
import { HttpExceptionFilter } from './http-exception.filter';

function run(exception: unknown) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ id: 'req-123' }) }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return { status: res.status.mock.calls[0]?.[0] as number, body: res.json.mock.calls[0]?.[0] };
}

describe('HttpExceptionFilter', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('hides internal error details and stack traces', () => {
    const { status, body } = run(new Error('db password is hunter2'));
    expect(status).toBe(500);
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: 'req-123',
      },
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('passes through AppError codes', () => {
    const { status, body } = run(AppError.forbidden());
    expect(status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('maps framework exceptions to stable codes', () => {
    expect(run(new NotFoundException()).body.error.code).toBe('NOT_FOUND');
    expect(run(new ThrottlerException()).body.error.code).toBe('RATE_LIMITED');
  });
});
