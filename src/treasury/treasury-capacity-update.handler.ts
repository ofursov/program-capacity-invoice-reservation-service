import { Injectable, Logger } from '@nestjs/common';
import { PrismaTx } from '../database/prisma-tx.type';
import { ProgramRepository } from '../programs/program.repository';
import { LedgerRepository } from '../audit/ledger.repository';
import { ProcessedKafkaMessageRepository } from './processed-kafka-message.repository';
import { TreasuryCapacityUpdateEvent } from './treasury-message.schemas';

export interface TreasuryMessageMeta {
  topic: string;
  partition: number;
  offsetValue: bigint;
  payloadHash: string;
}

export type TreasuryHandlerResultStatus =
  'applied' | 'duplicate' | 'stale' | 'ignored';

export interface TreasuryHandlerResult {
  status: TreasuryHandlerResultStatus;
}

@Injectable()
export class TreasuryCapacityUpdateHandler {
  private readonly logger = new Logger(TreasuryCapacityUpdateHandler.name);

  constructor(
    private readonly programRepository: ProgramRepository,
    private readonly ledgerRepository: LedgerRepository,
    private readonly processedMessages: ProcessedKafkaMessageRepository,
  ) {}

  async handle(
    client: PrismaTx,
    event: TreasuryCapacityUpdateEvent,
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
      // Already recorded under a different (topic, partition, offset); do not
      // insert again (external_message_id is unique) and do not re-apply.
      if (byMessageId.payload_hash !== meta.payloadHash) {
        this.logger.error(
          `Treasury message id ${event.messageId} reused with a different payload. Skipping to avoid applying conflicting data.`,
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
    const program = await this.programRepository.findByExternalRefForUpdate(
      client,
      event.programExternalRef,
    );

    if (!program) {
      const created = await this.programRepository.createFromTreasury(client, {
        externalRef: event.programExternalRef,
        currency: event.payload.currency,
        currencyExponent: event.payload.currencyExponent,
        totalLimitMinor: BigInt(event.payload.totalLimitMinor),
        treasuryVersion,
        occurredAt,
      });
      await this.ledgerRepository.insert(client, {
        programId: created.id,
        eventType: 'PROGRAM_CREATED',
        amountMinor: BigInt(event.payload.totalLimitMinor),
        currency: created.currency,
        source: 'treasury',
        externalMessageId: event.messageId,
        metadata: {
          totalLimitMinor: event.payload.totalLimitMinor,
        },
      });
    } else {
      const currentVersion = program.treasury_version
        ? BigInt(program.treasury_version)
        : null;
      if (currentVersion !== null && treasuryVersion <= currentVersion) {
        this.logger.warn(
          `Stale treasuryVersion for ${
            event.programExternalRef
          }: incoming=${treasuryVersion} current=${currentVersion}. Ignoring.`,
        );
        await this.processedMessages.markProcessed(client, {
          messageId: event.messageId,
          messageType: event.type,
          programExternalRef: event.programExternalRef,
          ...meta,
        });
        return { status: 'stale' };
      }

      const oldLimit = BigInt(program.total_limit_minor);
      const newLimit = BigInt(event.payload.totalLimitMinor);
      const updated = await this.programRepository.applyCapacityUpdate(
        client,
        program.id,
        {
          totalLimitMinor: newLimit,
          currency: event.payload.currency,
          currencyExponent: event.payload.currencyExponent,
          treasuryVersion,
          occurredAt,
        },
      );

      if (newLimit !== oldLimit) {
        await this.ledgerRepository.insert(client, {
          programId: updated.id,
          eventType: 'TREASURY_UPDATE_APPLIED',
          amountMinor: newLimit - oldLimit,
          currency: updated.currency,
          source: 'treasury',
          externalMessageId: event.messageId,
          metadata: {
            oldTotalLimitMinor: oldLimit.toString(),
            newTotalLimitMinor: newLimit.toString(),
          },
        });
      }
    }

    await this.processedMessages.markProcessed(client, {
      messageId: event.messageId,
      messageType: event.type,
      programExternalRef: event.programExternalRef,
      ...meta,
    });
    return { status: 'applied' };
  }
}
