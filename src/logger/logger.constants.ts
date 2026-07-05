export const REDACT_CENSOR = '[Redacted]';

export const DEFAULT_LOG_LEVEL_PRODUCTION = 'info';
export const DEFAULT_LOG_LEVEL_DEVELOPMENT = 'debug';

/** Operational endpoints that should never produce an HTTP access log line. */
export const IGNORED_ROUTES: readonly string[] = [
  '/health',
  '/health/live',
  '/health/ready',
  '/healthz',
  '/ready',
  '/readiness',
  '/liveness',
  '/metrics',
  '/favicon.ico',
];

/** Field names that may carry secrets wherever they appear in a logged object. */
export const SENSITIVE_FIELD_NAMES: readonly string[] = [
  'password',
  'passwordConfirm',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'secret',
  'clientSecret',
  'privateKey',
  'creditCard',
  'cardNumber',
  'cvv',
  'authorization',
  'cookie',
  'setCookie',
];

export const SAFE_REQUEST_HEADER_KEYS: readonly string[] = [
  'host',
  'user-agent',
  'x-request-id',
  'x-correlation-id',
];
