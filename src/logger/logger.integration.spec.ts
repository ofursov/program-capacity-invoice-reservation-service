import { Writable } from 'stream';
import {
  BadRequestException,
  Controller,
  Get,
  INestApplication,
  InternalServerErrorException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule, PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { App } from 'supertest/types';
import { REDACT_CENSOR } from './logger.constants';
import {
  attachRequestId,
  buildRedactionPaths,
  customLogLevel,
  genReqId,
  isIgnoredRoute,
  requestSerializer,
  responseSerializer,
} from './logger.utils';

class MemoryStream extends Writable {
  private buffer = '';

  _write(chunk: Buffer, _encoding: string, callback: () => void): void {
    this.buffer += chunk.toString();
    callback();
  }

  get lines(): Record<string, unknown>[] {
    return this.buffer
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

@Controller()
class TestController {
  constructor(private readonly pinoLogger: PinoLogger) {}

  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('bad')
  bad() {
    throw new BadRequestException('bad request');
  }

  @Get('boom')
  boom() {
    throw new InternalServerErrorException('boom');
  }

  @Get('health/live')
  healthLive() {
    return { status: 'ok' };
  }

  @Get('log-secrets')
  logSecrets() {
    this.pinoLogger.info(
      {
        password: 'secret-password',
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
        req: {
          headers: {
            authorization: 'Bearer secret-token',
            cookie: 'session=secret',
            'x-api-key': 'secret-api-key',
          },
        },
      },
      'Sensitive log test',
    );
    return { ok: true };
  }
}

describe('logger integration (nestjs-pino + pino-http)', () => {
  let app: INestApplication<App>;
  let stream: MemoryStream;

  beforeAll(async () => {
    stream = new MemoryStream();

    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            stream,
            genReqId,
            customLogLevel,
            customProps: (req: { id?: unknown }) => ({ requestId: req.id }),
            autoLogging: {
              ignore: (req: { url?: string }) => isIgnoredRoute(req.url ?? ''),
            },
            redact: { paths: buildRedactionPaths(), censor: REDACT_CENSOR },
            serializers: { req: requestSerializer, res: responseSerializer },
          },
        }),
      ],
      controllers: [TestController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(attachRequestId);
    app.useLogger(app.get(Logger));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function logsForPath(path: string) {
    return stream.lines.filter(
      (line) => (line.req as { url?: string } | undefined)?.url === path,
    );
  }

  it('reuses an incoming x-request-id in the response header and in the logs', async () => {
    const response = await request(app.getHttpServer())
      .get('/ok')
      .set('x-request-id', 'test-request-id')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('test-request-id');

    const completionLog = logsForPath('/ok').find(
      (line) => line.requestId === 'test-request-id',
    );
    expect(completionLog).toBeDefined();
    expect((completionLog?.req as { id?: string } | undefined)?.id).toBe(
      'test-request-id',
    );
  });

  it('generates a request id when none is supplied', async () => {
    const response = await request(app.getHttpServer()).get('/ok').expect(200);

    const generatedId = response.headers['x-request-id'];
    expect(generatedId).toBeTruthy();

    const completionLog = logsForPath('/ok').find(
      (line) => line.requestId === generatedId,
    );
    expect(completionLog).toBeDefined();
  });

  it('never leaks sensitive request headers into the logs', async () => {
    await request(app.getHttpServer())
      .get('/ok')
      .set('authorization', 'Bearer secret-token')
      .set('cookie', 'session=secret')
      .set('x-api-key', 'secret-api-key')
      .expect(200);

    const raw = JSON.stringify(stream.lines);
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('session=secret');
    expect(raw).not.toContain('secret-api-key');
  });

  it('redacts sensitive fields when an object is logged directly', async () => {
    await request(app.getHttpServer()).get('/log-secrets').expect(200);

    const line = stream.lines.find((l) => l.msg === 'Sensitive log test');
    expect(line).toBeDefined();

    const raw = JSON.stringify(line);
    expect(raw).not.toContain('secret-password');
    expect(raw).not.toContain('secret-access-token');
    expect(raw).not.toContain('secret-refresh-token');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('session=secret');
    expect(raw).not.toContain('secret-api-key');
    expect(raw).toContain(REDACT_CENSOR);
  });

  it('does not emit an HTTP access log for ignored health endpoints', async () => {
    const before = stream.lines.length;

    await request(app.getHttpServer()).get('/health/live').expect(200);

    const after = stream.lines.filter(
      (line) =>
        (line.req as { url?: string } | undefined)?.url === '/health/live',
    );
    expect(after).toHaveLength(0);
    expect(stream.lines.length).toBe(before);
  });

  it('maps 2xx/4xx/5xx responses to info/warn/error log levels', async () => {
    await request(app.getHttpServer()).get('/ok').expect(200);
    await request(app.getHttpServer()).get('/bad').expect(400);
    await request(app.getHttpServer()).get('/boom').expect(500);

    const okLog = logsForPath('/ok').find((l) => typeof l.msg === 'string');
    const badLog = logsForPath('/bad').find((l) => typeof l.msg === 'string');
    const boomLog = logsForPath('/boom').find((l) => typeof l.msg === 'string');

    expect(okLog?.level).toBe(30);
    expect(badLog?.level).toBe(40);
    expect(boomLog?.level).toBe(50);
  });
});
