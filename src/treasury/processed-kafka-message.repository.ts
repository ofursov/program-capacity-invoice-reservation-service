import { Injectable } from '@nestjs/common';
import { PrismaTx } from '../database/prisma-tx.type';

export interface ProcessedKafkaMessageRow {
  external_message_id: string;
  payload_hash: string;
}

export interface MarkProcessedInput {
  messageId: string;
  messageType: string;
  programExternalRef: string;
  topic: string;
  partition: number;
  offsetValue: bigint;
  payloadHash: string;
}

type ProcessedKafkaMessagePrismaTx = PrismaTx & {
  processedKafkaMessage: {
    findFirst: (args: {
      where: { topic: string; partition: number; offsetValue: bigint };
      select: { externalMessageId: true; payloadHash: true };
    }) => Promise<{ externalMessageId: string; payloadHash: string } | null>;
    findUnique: (args: {
      where: { externalMessageId: string };
      select: { externalMessageId: true; payloadHash: true };
    }) => Promise<{ externalMessageId: string; payloadHash: string } | null>;
  };
};

@Injectable()
export class ProcessedKafkaMessageRepository {
  async findByTopicPartitionOffset(
    tx: PrismaTx,
    topic: string,
    partition: number,
    offsetValue: bigint,
  ): Promise<ProcessedKafkaMessageRow | null> {
    const prismaTx = tx as ProcessedKafkaMessagePrismaTx;
    const message = await prismaTx.processedKafkaMessage.findFirst({
      where: { topic, partition, offsetValue },
      select: { externalMessageId: true, payloadHash: true },
    });
    return message
      ? {
          external_message_id: message.externalMessageId,
          payload_hash: message.payloadHash,
        }
      : null;
  }

  async findByExternalMessageId(
    tx: PrismaTx,
    externalMessageId: string,
  ): Promise<ProcessedKafkaMessageRow | null> {
    const prismaTx = tx as ProcessedKafkaMessagePrismaTx;
    const message = await prismaTx.processedKafkaMessage.findUnique({
      where: { externalMessageId },
      select: { externalMessageId: true, payloadHash: true },
    });
    return message
      ? {
          external_message_id: message.externalMessageId,
          payload_hash: message.payloadHash,
        }
      : null;
  }

  async markProcessed(tx: PrismaTx, input: MarkProcessedInput): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO processed_kafka_messages
        (id, message_type, program_external_ref, topic, partition, offset_value, external_message_id, payload_hash)
      VALUES (gen_random_uuid(), ${input.messageType}, ${input.programExternalRef}, ${input.topic},
              ${input.partition}, ${input.offsetValue}, ${input.messageId}, ${input.payloadHash})
      ON CONFLICT (topic, partition, offset_value) DO NOTHING
    `;
  }
}
