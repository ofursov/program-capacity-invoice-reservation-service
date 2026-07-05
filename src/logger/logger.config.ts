import { hostname } from 'os';
import type { ConfigService } from '@nestjs/config';
import type { Params } from 'nestjs-pino';
import type { IncomingMessage } from 'http';
import { EnvConfig } from '../config/env.schema';
import {
  DEFAULT_LOG_LEVEL_DEVELOPMENT,
  DEFAULT_LOG_LEVEL_PRODUCTION,
  REDACT_CENSOR,
} from './logger.constants';
import {
  buildRedactionPaths,
  customLogLevel,
  genReqId,
  isIgnoredRoute,
  requestSerializer,
  responseSerializer,
} from './logger.utils';

export function buildLoggerConfig(
  configService: ConfigService<EnvConfig, true>,
): Params {
  const nodeEnv = configService.get('NODE_ENV', { infer: true });
  const isDevelopment = nodeEnv === 'development';
  const isTest = nodeEnv === 'test';

  const serviceName = configService.get('SERVICE_NAME', { infer: true });
  const appVersion = configService.get('APP_VERSION', { infer: true });

  const logLevel =
    configService.get('LOG_LEVEL', { infer: true }) ??
    (isDevelopment
      ? DEFAULT_LOG_LEVEL_DEVELOPMENT
      : DEFAULT_LOG_LEVEL_PRODUCTION);

  const usePrettyTransport =
    (configService.get('LOG_PRETTY', { infer: true }) ?? isDevelopment) &&
    !isTest;

  return {
    pinoHttp: {
      level: logLevel,
      genReqId,
      customLogLevel,
      customProps: (req: IncomingMessage) => ({
        requestId: req.id,
      }),
      autoLogging: {
        ignore: (req: IncomingMessage) => isIgnoredRoute(req.url ?? ''),
      },
      redact: {
        paths: buildRedactionPaths(),
        censor: REDACT_CENSOR,
      },
      serializers: {
        req: requestSerializer,
        res: responseSerializer,
      },
      base: {
        pid: process.pid,
        hostname: hostname(),
        service: serviceName,
        env: nodeEnv,
        version: appVersion,
      },
      transport: usePrettyTransport
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    },
  };
}
