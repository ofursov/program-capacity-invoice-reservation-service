import { Module } from '@nestjs/common';
import { ProgramsModule } from '../programs/programs.module';
import { FxModule } from '../fx/fx.module';
import { AuditModule } from '../audit/audit.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { ReservationRepository } from './reservation.repository';

@Module({
  imports: [ProgramsModule, FxModule, AuditModule],
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationRepository],
  exports: [ReservationRepository],
})
export class ReservationsModule {}
