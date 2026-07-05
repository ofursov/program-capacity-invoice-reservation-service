import { Injectable, Logger } from '@nestjs/common';
import { PrismaTx } from '../database/prisma-tx.type';
import { ProgramRepository } from '../programs/program.repository';
import { LedgerRepository } from '../audit/ledger.repository';
import { ProcessedKafkaMessageRepository } from './processed-kafka-message.repository';
import { ReconciliationRepository } from './reconciliation.repository';
import {
  ReservationRepository,
  ReservationRow,
} from '../reservations/reservation.repository';
import { TreasuryReconciliationEvent } from './treasury-message.schemas';
import {
  TreasuryHandlerResult,
  TreasuryMessageMeta,
} from './treasury-capacity-update.handler';

@Injectable()
export class TreasuryReconciliationHandler {
  private readonly logger = new Logger(TreasuryReconciliationHandler.name);

  constructor(
    private readonly programRepository: ProgramRepository,
    private readonly ledgerRepository: LedgerRepository,
    private readonly processedMessages: ProcessedKafkaMessageRepository,
    private readonly reconciliationRepository: ReconciliationRepository,
    private readonly reservationRepository: ReservationRepository,
  ) {}

  async handle(
    client: PrismaTx,
    event: TreasuryReconciliationEvent,
    meta: TreasuryMessageMeta,
  ): Promise<TreasuryHandlerResult> {
    const byOffset = await this.processedMessages.findByTopicPartitionOffset(
      client,
      meta.topic,
      meta.partition,
      meta.offsetValue,
    );
    if (byOffset) {
      this.logger.log(
        `Duplicate delivery at ${meta.topic}:${meta.partition}:${meta.offsetValue}, skipping.`,
      );
      return { status: 'duplicate' };
    }

    const byMessageId = await this.processedMessages.findByExternalMessageId(
      client,
      event.messageId,
    );
    if (byMessageId) {
      if (byMessageId.payload_hash !== meta.payloadHash) {
        this.logger.error(
          `Treasury reconciliation message id ${event.messageId} reused with a different payload. Skipping to avoid applying conflicting data.`,
        );
        return { status: 'ignored' };
      }
      this.logger.log(
        `Duplicate treasury message ${event.messageId}, skipping.`,
      );
      return { status: 'duplicate' };
    }

    const treasuryVersion = BigInt(event.treasuryVersion);
    const occurredAt = new Date(event.occurredAt);
    const treasuryTotalLimitMinor = BigInt(event.payload.totalLimitMinor);
    const declaredReservedAmountMinor = BigInt(
      event.payload.reservedAmountMinor,
    );
    const activeReservations = event.payload.activeReservations;

    let program = await this.programRepository.findByExternalRefForUpdate(
      client,
      event.programExternalRef,
    );
    let justCreated = false;
    if (!program) {
      program = await this.programRepository.createFromTreasury(client, {
        externalRef: event.programExternalRef,
        currency: event.payload.currency,
        currencyExponent: event.payload.currencyExponent,
        totalLimitMinor: treasuryTotalLimitMinor,
        treasuryVersion,
        occurredAt,
      });
      justCreated = true;
    }

    const currentVersion = program.treasury_version
      ? BigInt(program.treasury_version)
      : null;
    const isStale =
      !justCreated &&
      currentVersion !== null &&
      treasuryVersion <= currentVersion;

    const localTotalLimitMinorBefore = BigInt(program.total_limit_minor);
    const localReservedAmountMinorBefore = BigInt(
      program.reserved_amount_minor,
    );

    if (isStale) {
      await this.reconciliationRepository.insert(client, {
        externalMessageId: event.messageId,
        programId: program.id,
        treasuryTotalLimitMinor,
        treasuryReservedAmountMinor: declaredReservedAmountMinor,
        localTotalLimitMinorBefore,
        localReservedAmountMinorBefore,
        totalLimitDifferenceMinor: 0n,
        reservedDifferenceMinor: 0n,
        status: 'STALE_SKIPPED',
        occurredAt,
        metadata: { currency: event.payload.currency },
      });
      this.logger.warn(
        `Stale treasuryVersion for reconciliation of ${event.programExternalRef}: incoming=${treasuryVersion} current=${currentVersion}. Recorded but not applied.`,
      );
      await this.processedMessages.markProcessed(client, {
        messageId: event.messageId,
        messageType: event.type,
        programExternalRef: event.programExternalRef,
        ...meta,
      });
      return { status: 'stale' };
    }

    const currencyMismatch = activeReservations.some(
      (item) => item.currency !== event.payload.currency,
    );
    const snapshotReservedAmountMinor = activeReservations.reduce(
      (sum, item) => sum + BigInt(item.reservedAmountMinor),
      0n,
    );
    const sumMismatch =
      snapshotReservedAmountMinor !== declaredReservedAmountMinor;

    if (currencyMismatch || sumMismatch) {
      await this.reconciliationRepository.insert(client, {
        externalMessageId: event.messageId,
        programId: program.id,
        treasuryTotalLimitMinor,
        treasuryReservedAmountMinor: declaredReservedAmountMinor,
        localTotalLimitMinorBefore,
        localReservedAmountMinorBefore,
        totalLimitDifferenceMinor: 0n,
        reservedDifferenceMinor: 0n,
        status: 'CONFLICT',
        occurredAt,
        metadata: {
          reason: currencyMismatch
            ? 'ACTIVE_RESERVATION_CURRENCY_MISMATCH'
            : 'RESERVED_AMOUNT_SUM_MISMATCH',
          declaredReservedAmountMinor: declaredReservedAmountMinor.toString(),
          computedReservedAmountMinor: snapshotReservedAmountMinor.toString(),
        },
      });
      this.logger.error(
        `Reconciliation conflict for ${event.programExternalRef} on message ${event.messageId}: ${
          currencyMismatch
            ? 'activeReservations contain a currency other than the program currency'
            : `declared reservedAmountMinor (${declaredReservedAmountMinor}) does not match sum of activeReservations (${snapshotReservedAmountMinor})`
        }. Message recorded but not applied.`,
      );
      await this.processedMessages.markProcessed(client, {
        messageId: event.messageId,
        messageType: event.type,
        programExternalRef: event.programExternalRef,
        ...meta,
      });
      return { status: 'ignored' };
    }

    const existingReservations =
      await this.reservationRepository.findAllForProgramForUpdate(
        client,
        program.id,
      );
    const existingByInvoiceId = new Map<string, ReservationRow>(
      existingReservations.map((row) => [row.invoice_id, row]),
    );
    const snapshotInvoiceIds = new Set(
      activeReservations.map((item) => item.invoiceId),
    );

    let insertedCount = 0;
    let updatedCount = 0;
    let conflictCount = 0;

    for (const item of activeReservations) {
      const reservedAmountMinor = BigInt(item.reservedAmountMinor);
      const existingRow = existingByInvoiceId.get(item.invoiceId);

      if (!existingRow) {
        await this.reservationRepository.insert(client, {
          programId: program.id,
          invoiceId: item.invoiceId,
          invoiceCurrency: item.currency,
          invoiceCurrencyExponent: program.currency_exponent,
          invoiceAmountMinor: reservedAmountMinor,
          programCurrency: program.currency,
          programCurrencyExponent: program.currency_exponent,
          reservedAmountMinor,
          fxRate: '1.0000000000',
          fxRateSource: 'TREASURY_RECONCILIATION',
          fxRateValidAt: occurredAt,
          source: 'TREASURY_RECONCILIATION',
          reconciliationMessageId: event.messageId,
        });
        insertedCount += 1;
        continue;
      }

      if (existingRow.status === 'RELEASED') {
        // Treasury believes this invoice is still active, but it was already
        // released locally. Do not reopen a released reservation
        // automatically; record the conflict and keep the local state as-is.
        conflictCount += 1;
        this.logger.warn(
          `Reconciliation for ${
            event.programExternalRef
          } references already-released reservation ${
            existingRow.id
          } (invoice ${item.invoiceId}); not reopening.`,
        );
        continue;
      }

      await this.reservationRepository.updateFromReconciliation(
        client,
        existingRow.id,
        {
          reservedAmountMinor,
          invoiceAmountMinor: reservedAmountMinor,
          invoiceCurrency: item.currency,
          invoiceCurrencyExponent: program.currency_exponent,
        },
      );
      updatedCount += 1;
    }

    let reconciledCount = 0;
    for (const row of existingReservations) {
      if (row.status === 'ACTIVE' && !snapshotInvoiceIds.has(row.invoice_id)) {
        await this.reservationRepository.markReconciled(
          client,
          row.id,
          event.messageId,
        );
        reconciledCount += 1;
      }
    }

    const totalLimitDifferenceMinor =
      treasuryTotalLimitMinor - localTotalLimitMinorBefore;
    const reservedDifferenceMinor =
      snapshotReservedAmountMinor - localReservedAmountMinorBefore;

    await this.reconciliationRepository.insert(client, {
      externalMessageId: event.messageId,
      programId: program.id,
      treasuryTotalLimitMinor,
      treasuryReservedAmountMinor: snapshotReservedAmountMinor,
      localTotalLimitMinorBefore,
      localReservedAmountMinorBefore,
      totalLimitDifferenceMinor,
      reservedDifferenceMinor,
      status: 'APPLIED',
      occurredAt,
      metadata: {
        currency: event.payload.currency,
        activeReservationsCount: activeReservations.length,
        insertedCount,
        updatedCount,
        reconciledCount,
        conflictCount,
      },
    });

    if (reservedDifferenceMinor !== 0n || totalLimitDifferenceMinor !== 0n) {
      await this.ledgerRepository.insert(client, {
        programId: program.id,
        eventType: 'TREASURY_RECONCILIATION_APPLIED',
        amountMinor: reservedDifferenceMinor,
        currency: event.payload.currency,
        source: 'treasury',
        externalMessageId: event.messageId,
        metadata: {
          totalLimitDifferenceMinor: totalLimitDifferenceMinor.toString(),
          reservedDifferenceMinor: reservedDifferenceMinor.toString(),
        },
      });
    }

    await this.programRepository.applyReconciliation(client, program.id, {
      totalLimitMinor: treasuryTotalLimitMinor,
      reservedAmountMinor: snapshotReservedAmountMinor,
      currency: event.payload.currency,
      currencyExponent: event.payload.currencyExponent,
      treasuryVersion,
      occurredAt,
    });

    await this.processedMessages.markProcessed(client, {
      messageId: event.messageId,
      messageType: event.type,
      programExternalRef: event.programExternalRef,
      ...meta,
    });
    return { status: 'applied' };
  }
}
