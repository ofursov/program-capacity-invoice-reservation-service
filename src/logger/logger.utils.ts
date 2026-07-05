import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { LevelWithSilent } from 'pino';
import {
  IGNORED_ROUTES,
  SAFE_REQUEST_HEADER_KEYS,
  SENSITIVE_FIELD_NAMES,
} from './logger.constants';

type Headers = Record<string, string | string[] | undefined>;

// pino-http augments `http.IncomingMessage` with an `id: ReqId` property;
// this just adds the extra fields Express attaches at runtime.
export interface RequestWithExtras extends IncomingMessage {
  query?: unknown;
  params?: unknown;
}

/**
 * Reuses an incoming `x-request-id`/`x-correlation-id` header when present,
 * otherwise mints a new one. Never falls back to a simple counter, since that
 * would collide across replicas.
 */
export function resolveIncomingRequestId(headers: Headers): string {
  const requestIdHeader = headers['x-request-id'];
  if (typeof requestIdHeader === 'string' && requestIdHeader.length > 0) {
    return requestIdHeader;
  }

  const correlationIdHeader = headers['x-correlation-id'];
  if (
    typeof correlationIdHeader === 'string' &&
    correlationIdHeader.length > 0
  ) {
    return correlationIdHeader;
  }

  return randomUUID();
}

export function genReqId(req: IncomingMessage): string {
  return resolveIncomingRequestId(req.headers);
}

/**
 * Plain Express middleware (registered via `app.use` in main.ts, ahead of
 * Nest-managed middleware) that pins the request id before pino-http runs,
 * and reflects it back on the response so callers can correlate their own logs.
 */
export function attachRequestId(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const requestId = resolveIncomingRequestId(req.headers);
  req.id = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

function stripQuery(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

export function isIgnoredRoute(url: string): boolean {
  return IGNORED_ROUTES.includes(stripQuery(url));
}

export function customLogLevel(
  _req: IncomingMessage,
  res: ServerResponse,
  err?: Error,
): LevelWithSilent {
  if (err || res.statusCode >= 500) {
    return 'error';
  }
  if (res.statusCode >= 400) {
    return 'warn';
  }
  return 'info';
}

export function requestSerializer(req: RequestWithExtras) {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const safeHeaders: Record<string, unknown> = {};
  for (const key of SAFE_REQUEST_HEADER_KEYS) {
    if (headers[key] !== undefined) {
      safeHeaders[key] = headers[key];
    }
  }

  return {
    id: req.id,
    method: req.method,
    url: req.url,
    query: req.query,
    params: req.params,
    headers: safeHeaders,
    remoteAddress: req.socket?.remoteAddress,
  };
}

export function responseSerializer(res: ServerResponse) {
  return {
    statusCode: res.statusCode,
  };
}

/**
 * Pino `redact.paths`. Request bodies aren't logged by default, but these
 * paths still guard against a developer accidentally logging a raw payload
 * or DTO that happens to carry a sensitive field.
 */
export function buildRedactionPaths(): string[] {
  const headerPaths = [
    'req.headers.authorization',
    'req.headers.cookie',
    "req.headers['proxy-authorization']",
    "req.headers['x-api-key']",
    "req.headers['x-auth-token']",
    "req.headers['x-csrf-token']",
    "res.headers['set-cookie']",
  ];

  const fieldPaths = SENSITIVE_FIELD_NAMES.flatMap((field) => [
    field,
    `*.${field}`,
    `req.body.${field}`,
  ]);

  return [...headerPaths, ...fieldPaths];
}
