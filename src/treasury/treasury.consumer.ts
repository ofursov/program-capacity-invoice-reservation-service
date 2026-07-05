import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Consumer, Kafka, KafkaMessage } from 'kafkajs';
import { PinoLogger } from 'nestjs-pino';
import { EnvConfig } from '../config/env.schema';
import { TransactionManager } from '../database/transaction-manager';
import { TreasuryCapacityUpdateHandler } from './treasury-capacity-update.handler';
import { TreasuryReconciliationHandler } from './treasury-reconciliation.handler';
import {
  parseTreasuryEvent,
  TreasuryEvent,
  TREASURY_TOPICS,
} from './treasury-message.schemas';

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

@Injectable()
export class TreasuryConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;

  constructor(
    configService: ConfigService<EnvConfig, true>,
    private readonly transactionManager: TransactionManager,
    private readonly capacityUpdateHandler: TreasuryCapacityUpdateHandler,
    private readonly reconciliationHandler: TreasuryReconciliationHandler,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TreasuryConsumer.name);
    this.kafka = new Kafka({
      clientId: configService.get('KAFKA_CLIENT_ID', { infer: true }),
      brokers: configService
        .get('KAFKA_BROKERS', { infer: true })
        .split(',')
        .map((broker) => broker.trim()),
    });
    this.consumer = this.kafka.consumer({
      groupId: configService.get('KAFKA_CONSUMER_GROUP_ID', { infer: true }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: TREASURY_TOPICS,
      fromBeginning: true,
    });
    await this.consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        await this.handleMessage(topic, partition, message);
      },
    });
    this.logger.info(
      `Subscribed to Kafka topics: ${TREASURY_TOPICS.join(', ')}.`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }

  private async handleMessage(
    topic: string,
    partition: number,
    message: KafkaMessage,
  ): Promise<void> {
    const offset = message.offset;
    const messageKey = message.key?.toString();
    const startedAt = Date.now();
    const rawValue = message.value?.toString() ?? 'null';
    let event: TreasuryEvent | undefined;

    try {
      const raw: unknown = JSON.parse(rawValue);
      event = parseTreasuryEvent(raw);
    } catch (error) {
      this.logger.warn({
        operation: 'treasury.message.validation_failed',
        component: 'treasury-consumer',
        topic,
        partition,
        offset,
        messageKey,
        durationMs: Date.now() - startedAt,
        error: serializeError(error),
      });
      await this.commitOffset(topic, partition, offset);
      return;
    }

    const payloadHash = createHash('sha256').update(rawValue).digest('hex');
    try {
      const result = await this.transactionManager.run((client) => {
        const meta = {
          topic,
          partition,
          offsetValue: BigInt(offset),
          payloadHash,
        };
        if (event.type === 'PROGRAM_CAPACITY_UPDATED') {
          return this.capacityUpdateHandler.handle(client, event, meta);
        } else if (event.type === 'PROGRAM_RECONCILIATION') {
          return this.reconciliationHandler.handle(client, event, meta);
        } else {
          throw new Error(
            `Unsupported treasury message type: ${(event as TreasuryEvent).type}`,
          );
        }
      });
      await this.commitOffset(topic, partition, offset);

      this.logger.info({
        operation: 'treasury.message.processed',
        component: 'treasury-consumer',
        topic,
        partition,
        offset,
        messageKey,
        messageId: event.messageId,
        messageType: event.type,
        programExternalRef: event.programExternalRef,
        treasuryVersion: event.treasuryVersion,
        result: result.status,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.logger.error({
        operation: 'treasury.message.failed',
        component: 'treasury-consumer',
        topic,
        partition,
        offset,
        messageKey,
        messageId: event.messageId,
        messageType: event.type,
        programExternalRef: event.programExternalRef,
        treasuryVersion: event.treasuryVersion,
        durationMs: Date.now() - startedAt,
        error: serializeError(error),
      });
      throw error;
    }
  }

  private async commitOffset(
    topic: string,
    partition: number,
    offset: string,
  ): Promise<void> {
    await this.consumer.commitOffsets([
      { topic, partition, offset: (BigInt(offset) + 1n).toString() },
    ]);
  }
}
