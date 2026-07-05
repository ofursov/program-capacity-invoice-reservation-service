import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { EnvConfig } from '../config/env.schema';
import { TransactionManager } from '../database/transaction-manager';
import { TreasuryCapacityUpdateHandler } from './treasury-capacity-update.handler';
import { TreasuryReconciliationHandler } from './treasury-reconciliation.handler';
import {
  CAPACITY_UPDATE_TOPIC,
  RECONCILIATION_TOPIC,
  TREASURY_TOPICS,
} from './treasury-message.schemas';
import { TreasuryConsumer } from './treasury.consumer';

interface EachMessageArgs {
  topic: string;
  partition: number;
  message: { value: Buffer; offset: string };
}

interface RunConfig {
  autoCommit: boolean;
  eachMessage: (args: EachMessageArgs) => Promise<void>;
}

const connect = jest.fn();
const subscribe = jest.fn();
const run = jest.fn<void, [RunConfig]>();
const commitOffsets = jest.fn();
const disconnect = jest.fn();

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: () => ({
      connect,
      subscribe,
      run,
      commitOffsets,
      disconnect,
    }),
  })),
}));

function buildConfigService(): ConfigService<EnvConfig, true> {
  const values: Record<string, string> = {
    KAFKA_CLIENT_ID: 'test-client',
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CONSUMER_GROUP_ID: 'test-group',
  };
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<EnvConfig, true>;
}

function buildLogger(): {
  info: jest.Mock<void, [Record<string, unknown>]>;
  warn: jest.Mock<void, [Record<string, unknown>]>;
  error: jest.Mock<void, [Record<string, unknown>]>;
  setContext: jest.Mock;
} {
  return {
    info: jest.fn<void, [Record<string, unknown>]>(),
    warn: jest.fn<void, [Record<string, unknown>]>(),
    error: jest.fn<void, [Record<string, unknown>]>(),
    setContext: jest.fn(),
  };
}

describe('TreasuryConsumer', () => {
  let transactionManager: { run: jest.Mock };
  let capacityHandler: { handle: jest.Mock };
  let reconciliationHandler: { handle: jest.Mock };
  let logger: ReturnType<typeof buildLogger>;
  let consumer: TreasuryConsumer;
  let eachMessage: (args: EachMessageArgs) => Promise<void>;

  beforeEach(async () => {
    jest.clearAllMocks();
    transactionManager = {
      run: jest.fn((work: (client: unknown) => Promise<unknown>) => work({})),
    };
    capacityHandler = {
      handle: jest.fn().mockResolvedValue({ status: 'applied' }),
    };
    reconciliationHandler = {
      handle: jest.fn().mockResolvedValue({ status: 'applied' }),
    };
    logger = buildLogger();

    consumer = new TreasuryConsumer(
      buildConfigService(),
      transactionManager as unknown as TransactionManager,
      capacityHandler as unknown as TreasuryCapacityUpdateHandler,
      reconciliationHandler as unknown as TreasuryReconciliationHandler,
      logger as unknown as PinoLogger,
    );

    await consumer.onModuleInit();
    eachMessage = run.mock.calls[0][0].eachMessage;
  });

  it('subscribes to both v2 treasury topics reading from the beginning', () => {
    expect(subscribe).toHaveBeenCalledWith({
      topics: TREASURY_TOPICS,
      fromBeginning: true,
    });
  });

  it('runs with autoCommit disabled', () => {
    expect(run.mock.calls[0][0].autoCommit).toBe(false);
  });

  it('routes a capacity update message to the capacity handler and commits the offset', async () => {
    const payload = {
      messageId: 'msg-1',
      type: 'PROGRAM_CAPACITY_UPDATED',
      programExternalRef: 'PROGRAM-ABC',
      treasuryVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: { currency: 'USD', currencyExponent: 2, totalLimitMinor: 100 },
    };

    await eachMessage({
      topic: CAPACITY_UPDATE_TOPIC,
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(payload)), offset: '5' },
    });

    expect(capacityHandler.handle).toHaveBeenCalledTimes(1);
    expect(reconciliationHandler.handle).not.toHaveBeenCalled();
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: CAPACITY_UPDATE_TOPIC, partition: 0, offset: '6' },
    ]);
  });

  it('routes a reconciliation message to the reconciliation handler', async () => {
    const payload = {
      messageId: 'recon-1',
      type: 'PROGRAM_RECONCILIATION',
      programExternalRef: 'PROGRAM-ABC',
      treasuryVersion: 2,
      occurredAt: new Date().toISOString(),
      payload: {
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 100,
        reservedAmountMinor: 50,
        activeReservations: [
          { invoiceId: 'INV-1', reservedAmountMinor: 50, currency: 'USD' },
        ],
      },
    };

    await eachMessage({
      topic: RECONCILIATION_TOPIC,
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(payload)), offset: '9' },
    });

    expect(reconciliationHandler.handle).toHaveBeenCalledTimes(1);
    expect(capacityHandler.handle).not.toHaveBeenCalled();
  });

  it('skips and commits the offset for an invalid message instead of throwing', async () => {
    await eachMessage({
      topic: CAPACITY_UPDATE_TOPIC,
      partition: 0,
      message: { value: Buffer.from('not json'), offset: '3' },
    });

    expect(capacityHandler.handle).not.toHaveBeenCalled();
    expect(commitOffsets).toHaveBeenCalledWith([
      { topic: CAPACITY_UPDATE_TOPIC, partition: 0, offset: '4' },
    ]);
  });

  it('does not commit the offset when the handler transaction fails', async () => {
    transactionManager.run.mockRejectedValueOnce(new Error('db down'));
    const payload = {
      messageId: 'msg-2',
      type: 'PROGRAM_CAPACITY_UPDATED',
      programExternalRef: 'PROGRAM-ABC',
      treasuryVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: { currency: 'USD', currencyExponent: 2, totalLimitMinor: 100 },
    };

    await expect(
      eachMessage({
        topic: CAPACITY_UPDATE_TOPIC,
        partition: 0,
        message: { value: Buffer.from(JSON.stringify(payload)), offset: '7' },
      }),
    ).rejects.toThrow('db down');

    expect(commitOffsets).not.toHaveBeenCalled();
  });

  it('logs a single INFO outcome log for a successfully processed message', async () => {
    const payload = {
      messageId: 'msg-001',
      type: 'PROGRAM_CAPACITY_UPDATED',
      programExternalRef: 'PROGRAM-ABC',
      treasuryVersion: 101,
      occurredAt: new Date().toISOString(),
      payload: { currency: 'USD', currencyExponent: 2, totalLimitMinor: 100 },
    };

    await eachMessage({
      topic: CAPACITY_UPDATE_TOPIC,
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(payload)), offset: '5' },
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'treasury.message.processed',
        component: 'treasury-consumer',
        topic: CAPACITY_UPDATE_TOPIC,
        partition: 0,
        offset: '5',
        messageId: 'msg-001',
        messageType: 'PROGRAM_CAPACITY_UPDATED',
        programExternalRef: 'PROGRAM-ABC',
        treasuryVersion: 101,
        result: 'applied',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        durationMs: expect.any(Number),
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs the final outcome as duplicate when the handler reports a duplicate delivery', async () => {
    capacityHandler.handle.mockResolvedValueOnce({ status: 'duplicate' });
    const payload = {
      messageId: 'msg-001',
      type: 'PROGRAM_CAPACITY_UPDATED',
      programExternalRef: 'PROGRAM-ABC',
      treasuryVersion: 101,
      occurredAt: new Date().toISOString(),
      payload: { currency: 'USD', currencyExponent: 2, totalLimitMinor: 100 },
    };

    await eachMessage({
      topic: CAPACITY_UPDATE_TOPIC,
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(payload)), offset: '5' },
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'treasury.message.processed',
        result: 'duplicate',
        messageId: 'msg-001',
      }),
    );
  });

  it('logs an ERROR and rethrows without committing the offset when processing fails', async () => {
    transactionManager.run.mockRejectedValueOnce(new Error('db down'));
    const payload = {
      messageId: 'msg-002',
      type: 'PROGRAM_CAPACITY_UPDATED',
      programExternalRef: 'PROGRAM-ABC',
      treasuryVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: { currency: 'USD', currencyExponent: 2, totalLimitMinor: 100 },
    };

    await expect(
      eachMessage({
        topic: CAPACITY_UPDATE_TOPIC,
        partition: 0,
        message: { value: Buffer.from(JSON.stringify(payload)), offset: '7' },
      }),
    ).rejects.toThrow('db down');

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'treasury.message.failed',
        component: 'treasury-consumer',
        topic: CAPACITY_UPDATE_TOPIC,
        partition: 0,
        offset: '7',
        messageId: 'msg-002',
        messageType: 'PROGRAM_CAPACITY_UPDATED',
        programExternalRef: 'PROGRAM-ABC',
        treasuryVersion: 1,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        error: expect.objectContaining({ message: 'db down' }),
      }),
    );
    expect(commitOffsets).not.toHaveBeenCalled();
  });

  it('never logs the full raw Kafka payload', async () => {
    const payload = {
      messageId: 'msg-003',
      type: 'PROGRAM_CAPACITY_UPDATED',
      programExternalRef: 'PROGRAM-ABC',
      treasuryVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: { currency: 'USD', currencyExponent: 2, totalLimitMinor: 100 },
    };

    await eachMessage({
      topic: CAPACITY_UPDATE_TOPIC,
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(payload)), offset: '5' },
    });

    const allLogCalls = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ];
    for (const [loggedArg] of allLogCalls) {
      expect(loggedArg).not.toHaveProperty('payload');
      expect(loggedArg).not.toHaveProperty('rawValue');
      expect(JSON.stringify(loggedArg)).not.toContain('totalLimitMinor');
    }
  });

  it('disconnects the consumer on module destroy', async () => {
    await consumer.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
