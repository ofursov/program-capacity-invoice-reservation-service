import type { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.schema';
import { buildLoggerConfig } from './logger.config';

function fakeConfigService(
  overrides: Partial<EnvConfig>,
): ConfigService<EnvConfig, true> {
  const values: Partial<EnvConfig> = {
    NODE_ENV: 'development',
    SERVICE_NAME: 'finverity-reservation-program',
    APP_VERSION: 'local',
    ...overrides,
  };
  return {
    get: (key: keyof EnvConfig) => values[key],
  } as unknown as ConfigService<EnvConfig, true>;
}

describe('buildLoggerConfig', () => {
  it('emits raw JSON (no pino-pretty transport) in production', () => {
    const config = buildLoggerConfig(
      fakeConfigService({ NODE_ENV: 'production' }),
    );
    expect(config.pinoHttp).toMatchObject({ level: 'info' });
    expect(
      (config.pinoHttp as { transport?: unknown }).transport,
    ).toBeUndefined();
  });

  it('uses pino-pretty only in local development', () => {
    const config = buildLoggerConfig(
      fakeConfigService({ NODE_ENV: 'development' }),
    );
    expect(config.pinoHttp).toMatchObject({ level: 'debug' });
    expect(
      (config.pinoHttp as { transport?: { target?: string } }).transport
        ?.target,
    ).toBe('pino-pretty');
  });

  it('never enables pino-pretty in test, even if LOG_PRETTY=true', () => {
    const config = buildLoggerConfig(
      fakeConfigService({ NODE_ENV: 'test', LOG_PRETTY: true }),
    );
    expect(
      (config.pinoHttp as { transport?: unknown }).transport,
    ).toBeUndefined();
  });

  it('respects an explicit LOG_LEVEL override', () => {
    const config = buildLoggerConfig(
      fakeConfigService({ NODE_ENV: 'production', LOG_LEVEL: 'warn' }),
    );
    expect(config.pinoHttp).toMatchObject({ level: 'warn' });
  });

  it('respects an explicit LOG_PRETTY=true in development-like non-test envs', () => {
    const config = buildLoggerConfig(
      fakeConfigService({ NODE_ENV: 'production', LOG_PRETTY: true }),
    );
    expect(
      (config.pinoHttp as { transport?: { target?: string } }).transport
        ?.target,
    ).toBe('pino-pretty');
  });

  it('stamps the base log fields with service/env/version', () => {
    const config = buildLoggerConfig(
      fakeConfigService({
        NODE_ENV: 'production',
        SERVICE_NAME: 'my-service',
        APP_VERSION: '1.2.3',
      }),
    );
    expect(
      (config.pinoHttp as { base?: Record<string, unknown> }).base,
    ).toMatchObject({
      service: 'my-service',
      env: 'production',
      version: '1.2.3',
    });
  });
});
