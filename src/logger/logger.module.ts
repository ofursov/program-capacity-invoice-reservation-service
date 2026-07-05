import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { EnvConfig } from '../config/env.schema';
import { buildLoggerConfig } from './logger.config';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig, true>) =>
        buildLoggerConfig(configService),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class AppLoggerModule {}
