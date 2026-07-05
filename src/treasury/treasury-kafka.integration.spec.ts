import { randomUUID as uuid } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer } from 'kafkajs';
import { PrismaClient } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { EnvConfig } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { TransactionManager } from '../database/transaction-manager';
import { ProgramRepository } from '../programs/program.repository';
import { ReservationRepository } from '../reservations/reservation.repository';
import { LedgerRepository } from '../audit/ledger.repository';
import { ProcessedKafkaMessageRepository } from './processed-kafka-message.repository';
import { ReconciliationRepository } from './reconciliation.repository';
import { TreasuryCapacityUpdateHandler } from './treasury-capacity-update.handler';
import { TreasuryReconciliationHandler } from './treasury-reconciliation.handler';
import {
  CAPACITY_UPDATE_TOPIC,
  RECONCILIATION_TOPIC,
} from './treasury-message.schemas';
import { TreasuryConsumer } from './treasury.consumer';

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? 'localhost:9092';

function buildConfigService(groupId: string): ConfigService<EnvConfig, true> {
  const values: Record<string, string> = {
    KAFKA_CLIENT_ID: 'treasury-kafka-integration-test',
    KAFKA_BROKERS,
    KAFKA_CONSUMER_GROUP_ID: groupId,
  };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<EnvConfig, true>;
}

async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for condition.');
}

describe('TreasuryConsumer against a real Kafka broker (integration)', () => {
  let prisma: PrismaClient;
  let consumer: TreasuryConsumer;
  let producer: Producer;

  beforeAll(async () => {
    prisma = new PrismaClient();

    const transactionManager = new TransactionManager(
      prisma as unknown as PrismaService,
    );
    const programRepository = new ProgramRepository();
    const reservationRepository = new ReservationRepository(
      prisma as unknown as PrismaService,
    );
    const ledgerRepository = new LedgerRepository();
    const processedMessages = new ProcessedKafkaMessageRepository();
    const reconciliationRepository = new ReconciliationRepository();
    const capacityHandler = new TreasuryCapacityUpdateHandler(
      programRepository,
      ledgerRepository,
      processedMessages,
    );
    const reconciliationHandler = new TreasuryReconciliationHandler(
      programRepository,
      ledgerRepository,
      processedMessages,
      reconciliationRepository,
      reservationRepository,
    );

    consumer = new TreasuryConsumer(
      buildConfigService(`treasury-kafka-integration-test-${uuid()}`),
      transactionManager,
      capacityHandler,
      reconciliationHandler,
      {
        setContext: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as unknown as PinoLogger,
    );
    await consumer.onModuleInit();

    const kafka = new Kafka({
      clientId: 'treasury-kafka-integration-test-producer',
      brokers: KAFKA_BROKERS.split(','),
    });
    producer = kafka.producer();
    await producer.connect();
  }, 30_000);

  afterAll(async () => {
    await consumer.onModuleDestroy();
    await producer.disconnect();
    await prisma.$disconnect();
  });

  it('consumes a real capacity update message from Redpanda and applies it', async () => {
    const externalRef = `PROGRAM-KAFKA-${uuid()}`;
    const message = {
      messageId: uuid(),
      type: 'PROGRAM_CAPACITY_UPDATED',
      programExternalRef: externalRef,
      treasuryVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: {
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 5_000_000,
      },
    };

    await producer.send({
      topic: CAPACITY_UPDATE_TOPIC,
      messages: [{ key: externalRef, value: JSON.stringify(message) }],
    });

    const program = await waitFor(() =>
      prisma.program.findUnique({ where: { externalRef } }),
    );

    expect(program?.totalLimitMinor).toBe(5_000_000n);
    expect(program?.treasuryVersion).toBe(1n);
  }, 20_000);

  it('consumes a real reconciliation message and applies an audited adjustment', async () => {
    const externalRef = `PROGRAM-KAFKA-RECON-${uuid()}`;
    const message = {
      messageId: uuid(),
      type: 'PROGRAM_RECONCILIATION',
      programExternalRef: externalRef,
      treasuryVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: {
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 5_000_000,
        reservedAmountMinor: 1_000_000,
        activeReservations: [
          {
            invoiceId: 'INV-1',
            reservedAmountMinor: 1_000_000,
            currency: 'USD',
          },
        ],
      },
    };

    await producer.send({
      topic: RECONCILIATION_TOPIC,
      messages: [{ key: externalRef, value: JSON.stringify(message) }],
    });

    const program = await waitFor(() =>
      prisma.program.findUnique({ where: { externalRef } }),
    );

    expect(program?.reservedAmountMinor).toBe(1_000_000n);

    const runs = await prisma.reconciliationRun.findMany({
      where: { programId: program.id },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('APPLIED');
  }, 20_000);
});
