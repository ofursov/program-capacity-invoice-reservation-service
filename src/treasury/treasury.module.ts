import { Module } from '@nestjs/common';
import { ProgramsModule } from '../programs/programs.module';
import { AuditModule } from '../audit/audit.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { TreasuryConsumer } from './treasury.consumer';
import { TreasuryCapacityUpdateHandler } from './treasury-capacity-update.handler';
import { TreasuryReconciliationHandler } from './treasury-reconciliation.handler';
import { ProcessedKafkaMessageRepository } from './processed-kafka-message.repository';
import { ReconciliationRepository } from './reconciliation.repository';

@Module({
  imports: [ProgramsModule, AuditModule, ReservationsModule],
  providers: [
    TreasuryConsumer,
    TreasuryCapacityUpdateHandler,
    TreasuryReconciliationHandler,
    ProcessedKafkaMessageRepository,
    ReconciliationRepository,
  ],
})
export class TreasuryModule {}
