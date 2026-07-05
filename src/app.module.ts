import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { AppLoggerModule } from './logger/logger.module';
import { ProgramsModule } from './programs/programs.module';
import { ReservationsModule } from './reservations/reservations.module';
import { TreasuryModule } from './treasury/treasury.module';

@Module({
  imports: [
    ConfigModule,
    AppLoggerModule,
    DatabaseModule,
    AuthModule,
    HealthModule,
    ProgramsModule,
    ReservationsModule,
    TreasuryModule,
  ],
})
export class AppModule {}
