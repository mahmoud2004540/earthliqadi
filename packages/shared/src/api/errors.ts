/** Stable, machine-readable error codes returned by the API. */
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'CSRF_INVALID',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'ACCOUNT_NOT_ACTIVE',
  'EMAIL_NOT_VERIFIED',
  'INVALID_TOKEN',
  'MFA_INVALID',
  'MFA_ALREADY_ENABLED',
  'MFA_NOT_ENABLED',
  'INSUFFICIENT_FUNDS',
  'IDEMPOTENCY_CONFLICT',
  'LIMIT_EXCEEDED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId?: string;
    details?: { path: string; message: string }[];
  };
}
