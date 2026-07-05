import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.schema';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ScopesGuard } from './scopes.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<EnvConfig, true>) => ({
        secret: configService.get('JWT_SECRET', { infer: true }),
      }),
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
  exports: [JwtModule],
})
export class AuthModule {}
