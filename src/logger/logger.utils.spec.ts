import {
  buildRedactionPaths,
  customLogLevel,
  isIgnoredRoute,
  requestSerializer,
  resolveIncomingRequestId,
  responseSerializer,
} from './logger.utils';

describe('resolveIncomingRequestId', () => {
  it('reuses x-request-id when present', () => {
    expect(resolveIncomingRequestId({ 'x-request-id': 'req-abc' })).toBe(
      'req-abc',
    );
  });

  it('falls back to x-correlation-id when x-request-id is absent', () => {
    expect(resolveIncomingRequestId({ 'x-correlation-id': 'corr-abc' })).toBe(
      'corr-abc',
    );
  });

  it('prefers x-request-id over x-correlation-id when both are present', () => {
    expect(
      resolveIncomingRequestId({
        'x-request-id': 'req-abc',
        'x-correlation-id': 'corr-abc',
      }),
    ).toBe('req-abc');
  });

  it('generates a uuid when neither header is present', () => {
    const id = resolveIncomingRequestId({});
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('generates a fresh uuid on every call (no shared counter)', () => {
    expect(resolveIncomingRequestId({})).not.toBe(resolveIncomingRequestId({}));
  });
});

describe('isIgnoredRoute', () => {
  it.each([
    '/health',
    '/health/live',
    '/health/ready',
    '/healthz',
    '/ready',
    '/readiness',
    '/liveness',
    '/metrics',
    '/favicon.ico',
  ])('ignores %s', (path) => {
    expect(isIgnoredRoute(path)).toBe(true);
  });

  it('ignores an ignored route even with a query string', () => {
    expect(isIgnoredRoute('/health/live?foo=bar')).toBe(true);
  });

  it('does not ignore application routes', () => {
    expect(isIgnoredRoute('/v1/reservations')).toBe(false);
  });
});

describe('customLogLevel', () => {
  const res = (statusCode: number) => ({ statusCode }) as never;

  it('maps 2xx/3xx to info', () => {
    expect(customLogLevel({} as never, res(200))).toBe('info');
    expect(customLogLevel({} as never, res(302))).toBe('info');
  });

  it('maps 4xx to warn', () => {
    expect(customLogLevel({} as never, res(404))).toBe('warn');
  });

  it('maps 5xx to error', () => {
    expect(customLogLevel({} as never, res(500))).toBe('error');
  });

  it('maps an error to error regardless of status code', () => {
    expect(customLogLevel({} as never, res(200), new Error('boom'))).toBe(
      'error',
    );
  });
});

describe('requestSerializer', () => {
  it('only includes safe headers and drops everything else', () => {
    const serialized = requestSerializer({
      id: 'req-1',
      method: 'GET',
      url: '/v1/reservations',
      query: { a: '1' },
      params: { id: '2' },
      headers: {
        host: 'example.com',
        'user-agent': 'jest',
        'x-request-id': 'req-1',
        authorization: 'Bearer secret-token',
        cookie: 'session=secret',
      },
      socket: { remoteAddress: '127.0.0.1' },
    } as never);

    expect(serialized.headers).toEqual({
      host: 'example.com',
      'user-agent': 'jest',
      'x-request-id': 'req-1',
    });
    expect(serialized).not.toHaveProperty('body');
    expect(JSON.stringify(serialized)).not.toContain('secret-token');
    expect(JSON.stringify(serialized)).not.toContain('session=secret');
    expect(serialized.id).toBe('req-1');
    expect(serialized.remoteAddress).toBe('127.0.0.1');
  });
});

describe('responseSerializer', () => {
  it('only exposes the status code', () => {
    expect(responseSerializer({ statusCode: 201 } as never)).toEqual({
      statusCode: 201,
    });
  });
});

describe('buildRedactionPaths', () => {
  const paths = buildRedactionPaths();

  it('redacts sensitive request headers', () => {
    expect(paths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        "req.headers['proxy-authorization']",
        "req.headers['x-api-key']",
        "req.headers['x-auth-token']",
        "req.headers['x-csrf-token']",
        "res.headers['set-cookie']",
      ]),
    );
  });

  it('redacts sensitive fields at the root, one level deep, and under req.body', () => {
    for (const field of ['password', 'accessToken', 'refreshToken']) {
      expect(paths).toContain(field);
      expect(paths).toContain(`*.${field}`);
      expect(paths).toContain(`req.body.${field}`);
    }
  });
});
