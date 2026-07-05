import { Module } from '@nestjs/common';
import { LedgerRepository } from './ledger.repository';

@Module({
  providers: [LedgerRepository],
  exports: [LedgerRepository],
})
export class AuditModule {}
