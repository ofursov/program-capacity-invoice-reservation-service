import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaTx } from '../database/prisma-tx.type';

export type LedgerEventType =
  | 'PROGRAM_CREATED'
  | 'CAPACITY_INCREASED'
  | 'CAPACITY_DECREASED'
  | 'RESERVATION_CREATED'
  | 'RESERVATION_RELEASED'
  | 'TREASURY_RECONCILIATION_APPLIED'
  | 'TREASURY_UPDATE_APPLIED';

export interface InsertLedgerEntryInput {
  programId: string;
  reservationId?: string;
  eventType: LedgerEventType;
  amountMinor: bigint;
  currency: string;
  source: string;
  externalMessageId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class LedgerRepository {
  async insert(tx: PrismaTx, input: InsertLedgerEntryInput): Promise<void> {
    await tx.capacityLedgerEntry.create({
      data: {
        programId: input.programId,
        reservationId: input.reservationId ?? null,
        eventType: input.eventType,
        amountMinor: input.amountMinor,
        currency: input.currency,
        source: input.source,
        externalMessageId: input.externalMessageId ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
}
