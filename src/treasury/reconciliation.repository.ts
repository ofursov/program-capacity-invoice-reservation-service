import { Injectable } from '@nestjs/common';
import { PrismaTx } from '../database/prisma-tx.type';

export interface InsertReconciliationRunInput {
  externalMessageId: string;
  programId: string;
  treasuryTotalLimitMinor: bigint;
  treasuryReservedAmountMinor: bigint;
  localTotalLimitMinorBefore: bigint;
  localReservedAmountMinorBefore: bigint;
  totalLimitDifferenceMinor: bigint;
  reservedDifferenceMinor: bigint;
  status: 'APPLIED' | 'STALE_SKIPPED' | 'CONFLICT';
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class ReconciliationRepository {
  async insert(
    tx: PrismaTx,
    input: InsertReconciliationRunInput,
  ): Promise<void> {
    const metadata = JSON.stringify(input.metadata ?? {});
    await tx.$executeRaw`
      INSERT INTO reconciliation_runs
        (id, external_message_id, program_id,
         treasury_total_limit_minor, treasury_reserved_amount_minor,
         local_total_limit_minor_before, local_reserved_amount_minor_before,
         total_limit_difference_minor, reserved_difference_minor,
         status, occurred_at, metadata)
      VALUES (gen_random_uuid(), ${input.externalMessageId}, ${input.programId}::uuid,
              ${input.treasuryTotalLimitMinor}, ${input.treasuryReservedAmountMinor},
              ${input.localTotalLimitMinorBefore}, ${input.localReservedAmountMinorBefore},
              ${input.totalLimitDifferenceMinor}, ${input.reservedDifferenceMinor},
              ${input.status}, ${input.occurredAt}, ${metadata}::jsonb)
      ON CONFLICT (external_message_id) DO NOTHING
    `;
  }
}
