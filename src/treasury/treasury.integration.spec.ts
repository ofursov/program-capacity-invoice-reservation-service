import { randomUUID as uuid } from 'crypto';
import { createHash } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { PrismaService } from '../database/prisma.service';
import { TransactionManager } from '../database/transaction-manager';
import { ProgramsModule } from '../programs/programs.module';
import { AuditModule } from '../audit/audit.module';
import { ReservationsModule } from '../reservations/reservations.module';
import { TreasuryCapacityUpdateHandler } from './treasury-capacity-update.handler';
import { TreasuryReconciliationHandler } from './treasury-reconciliation.handler';
import { ProcessedKafkaMessageRepository } from './processed-kafka-message.repository';
import { ReconciliationRepository } from './reconciliation.repository';
import {
  TreasuryActiveReservation,
  TreasuryCapacityUpdateEvent,
  TreasuryReconciliationEvent,
} from './treasury-message.schemas';
import {
  cleanBusinessData,
  ensureReferenceData,
} from '../test-support/db-test-utils';

function hashOf(event: unknown): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

describe('Treasury handlers (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transactionManager: TransactionManager;
  let capacityHandler: TreasuryCapacityUpdateHandler;
  let reconciliationHandler: TreasuryReconciliationHandler;

  function meta(topic: string, offsetValue: bigint, event: unknown) {
    return {
      topic,
      partition: 0,
      offsetValue,
      payloadHash: hashOf(event),
    };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        DatabaseModule,
        ProgramsModule,
        AuditModule,
        ReservationsModule,
      ],
      providers: [
        TreasuryCapacityUpdateHandler,
        TreasuryReconciliationHandler,
        ProcessedKafkaMessageRepository,
        ReconciliationRepository,
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    transactionManager = moduleRef.get(TransactionManager);
    capacityHandler = moduleRef.get(TreasuryCapacityUpdateHandler);
    reconciliationHandler = moduleRef.get(TreasuryReconciliationHandler);
    await ensureReferenceData(prisma);
  });

  afterAll(async () => {
    await cleanBusinessData(prisma);
    await moduleRef.close();
  });

  afterEach(async () => {
    await cleanBusinessData(prisma);
  });

  const CAPACITY_TOPIC = 'treasury.program-capacity-updated.v1';
  const RECONCILIATION_TOPIC = 'treasury.program-reconciliation.v1';

  function capacityUpdateEvent(
    overrides: Partial<TreasuryCapacityUpdateEvent> = {},
  ): TreasuryCapacityUpdateEvent {
    return {
      messageId: uuid(),
      type: 'PROGRAM_CAPACITY_UPDATED',
      programExternalRef: 'PROGRAM-TREASURY-1',
      treasuryVersion: 1,
      occurredAt: new Date().toISOString(),
      payload: {
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 1_000_000,
      },
      ...overrides,
    };
  }

  it('creates a new program from a capacity update message', async () => {
    const event = capacityUpdateEvent();
    await transactionManager.run((client) =>
      capacityHandler.handle(client, event, meta(CAPACITY_TOPIC, 1n, event)),
    );

    const program = await prisma.program.findUniqueOrThrow({
      where: { externalRef: event.programExternalRef },
    });
    expect(program.totalLimitMinor).toBe(1_000_000n);
    expect(program.treasuryVersion).toBe(1n);

    const ledgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { programId: program.id },
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].eventType).toBe('PROGRAM_CREATED');
  });

  it('updates the total limit on a subsequent capacity update', async () => {
    const first = capacityUpdateEvent({ treasuryVersion: 1 });
    await transactionManager.run((client) =>
      capacityHandler.handle(client, first, meta(CAPACITY_TOPIC, 1n, first)),
    );
    const second = capacityUpdateEvent({
      treasuryVersion: 2,
      messageId: uuid(),
      payload: {
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 2_000_000,
      },
    });
    await transactionManager.run((client) =>
      capacityHandler.handle(client, second, meta(CAPACITY_TOPIC, 2n, second)),
    );

    const program = await prisma.program.findUniqueOrThrow({
      where: { externalRef: 'PROGRAM-TREASURY-1' },
    });
    expect(program.totalLimitMinor).toBe(2_000_000n);
    expect(program.treasuryVersion).toBe(2n);

    const ledgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { programId: program.id },
    });
    expect(ledgerEntries).toHaveLength(2);
    expect(ledgerEntries[1].eventType).toBe('TREASURY_UPDATE_APPLIED');
  });

  it('ignores a stale treasuryVersion capacity update', async () => {
    const first = capacityUpdateEvent({ treasuryVersion: 5 });
    await transactionManager.run((client) =>
      capacityHandler.handle(client, first, meta(CAPACITY_TOPIC, 1n, first)),
    );
    const stale = capacityUpdateEvent({
      treasuryVersion: 3,
      messageId: uuid(),
      payload: {
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 999,
      },
    });
    await transactionManager.run((client) =>
      capacityHandler.handle(client, stale, meta(CAPACITY_TOPIC, 2n, stale)),
    );

    const program = await prisma.program.findUniqueOrThrow({
      where: { externalRef: 'PROGRAM-TREASURY-1' },
    });
    expect(program.totalLimitMinor).toBe(1_000_000n);
    expect(program.treasuryVersion).toBe(5n);
  });

  it('skips an exact redelivery at the same topic/partition/offset', async () => {
    const event = capacityUpdateEvent();
    const m = meta(CAPACITY_TOPIC, 1n, event);
    await transactionManager.run((client) =>
      capacityHandler.handle(client, event, m),
    );
    await transactionManager.run((client) =>
      capacityHandler.handle(client, event, m),
    );

    const ledgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { program: { externalRef: event.programExternalRef } },
    });
    expect(ledgerEntries).toHaveLength(1);
  });

  it('skips a duplicate messageId delivered at a new offset without reapplying', async () => {
    const event = capacityUpdateEvent();
    await transactionManager.run((client) =>
      capacityHandler.handle(client, event, meta(CAPACITY_TOPIC, 1n, event)),
    );
    const conflicting = { ...event, payload: { ...event.payload, totalLimitMinor: 42 } };
    await transactionManager.run((client) =>
      capacityHandler.handle(
        client,
        conflicting,
        meta(CAPACITY_TOPIC, 2n, conflicting),
      ),
    );

    const program = await prisma.program.findUniqueOrThrow({
      where: { externalRef: event.programExternalRef },
    });
    expect(program.totalLimitMinor).toBe(1_000_000n);

    const ledgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { programId: program.id },
    });
    expect(ledgerEntries).toHaveLength(1);
  });

  function reconciliationEvent(
    overrides: Partial<TreasuryReconciliationEvent> = {},
    activeReservations: TreasuryActiveReservation[] = [],
  ): TreasuryReconciliationEvent {
    const reservedAmountMinor = activeReservations.reduce(
      (sum, item) => sum + item.reservedAmountMinor,
      0,
    );
    return {
      messageId: uuid(),
      type: 'PROGRAM_RECONCILIATION',
      programExternalRef: 'PROGRAM-RECON-1',
      treasuryVersion: 10,
      occurredAt: new Date().toISOString(),
      payload: {
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 1_000_000,
        reservedAmountMinor,
        activeReservations,
      },
      ...overrides,
    };
  }

  it('applies aggregate + reservation-level state from activeReservations', async () => {
    const event = reconciliationEvent({}, [
      { invoiceId: 'INV-1', reservedAmountMinor: 100_000, currency: 'USD' },
      { invoiceId: 'INV-2', reservedAmountMinor: 150_000, currency: 'USD' },
    ]);
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        event,
        meta(RECONCILIATION_TOPIC, 1n, event),
      ),
    );

    const program = await prisma.program.findUniqueOrThrow({
      where: { externalRef: event.programExternalRef },
    });
    expect(program.reservedAmountMinor).toBe(250_000n);
    expect(program.lastReconciledAt).not.toBeNull();

    const reservations = await prisma.invoiceReservation.findMany({
      where: { programId: program.id },
      orderBy: { invoiceId: 'asc' },
    });
    expect(reservations).toHaveLength(2);
    expect(reservations.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect(reservations.every((r) => r.source === 'TREASURY_RECONCILIATION')).toBe(
      true,
    );

    const reconciliationRuns = await prisma.reconciliationRun.findMany({
      where: { programId: program.id },
    });
    expect(reconciliationRuns).toHaveLength(1);
    expect(reconciliationRuns[0].reservedDifferenceMinor).toBe(250_000n);
    expect(reconciliationRuns[0].status).toBe('APPLIED');

    const ledgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { programId: program.id },
    });
    const applied = ledgerEntries.find(
      (e) => e.eventType === 'TREASURY_RECONCILIATION_APPLIED',
    );
    expect(applied?.amountMinor).toBe(250_000n);
  });

  it('marks a locally active reservation absent from the snapshot as RECONCILED', async () => {
    const first = reconciliationEvent({}, [
      { invoiceId: 'INV-1', reservedAmountMinor: 100_000, currency: 'USD' },
    ]);
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        first,
        meta(RECONCILIATION_TOPIC, 1n, first),
      ),
    );

    const second = reconciliationEvent(
      { treasuryVersion: 11, messageId: uuid() },
      [],
    );
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        second,
        meta(RECONCILIATION_TOPIC, 2n, second),
      ),
    );

    const program = await prisma.program.findUniqueOrThrow({
      where: { externalRef: first.programExternalRef },
    });
    expect(program.reservedAmountMinor).toBe(0n);

    const reservation = await prisma.invoiceReservation.findFirstOrThrow({
      where: { programId: program.id, invoiceId: 'INV-1' },
    });
    expect(reservation.status).toBe('RECONCILED');
    expect(reservation.reconciledAt).not.toBeNull();
    expect(reservation.reconciliationMessageId).toBe(second.messageId);
  });

  it('reactivates a RECONCILED reservation that reappears in a later snapshot', async () => {
    const first = reconciliationEvent({}, [
      { invoiceId: 'INV-1', reservedAmountMinor: 100_000, currency: 'USD' },
    ]);
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        first,
        meta(RECONCILIATION_TOPIC, 1n, first),
      ),
    );
    const dropped = reconciliationEvent(
      { treasuryVersion: 11, messageId: uuid() },
      [],
    );
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        dropped,
        meta(RECONCILIATION_TOPIC, 2n, dropped),
      ),
    );
    const reappeared = reconciliationEvent(
      { treasuryVersion: 12, messageId: uuid() },
      [{ invoiceId: 'INV-1', reservedAmountMinor: 120_000, currency: 'USD' }],
    );
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        reappeared,
        meta(RECONCILIATION_TOPIC, 3n, reappeared),
      ),
    );

    const program = await prisma.program.findUniqueOrThrow({
      where: { externalRef: first.programExternalRef },
    });
    expect(program.reservedAmountMinor).toBe(120_000n);

    const reservation = await prisma.invoiceReservation.findFirstOrThrow({
      where: { programId: program.id, invoiceId: 'INV-1' },
    });
    expect(reservation.status).toBe('ACTIVE');
    expect(reservation.reservedAmountMinor).toBe(120_000n);
  });

  it('records a conflict and skips applying when a currency in activeReservations differs from the program currency', async () => {
    const event = reconciliationEvent({}, [
      { invoiceId: 'INV-1', reservedAmountMinor: 100_000, currency: 'EUR' },
    ]);
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        event,
        meta(RECONCILIATION_TOPIC, 1n, event),
      ),
    );

    const program = await prisma.program.findUniqueOrThrow({
      where: { externalRef: event.programExternalRef },
    });
    expect(program.reservedAmountMinor).toBe(0n);
    expect(program.lastReconciledAt).toBeNull();

    const runs = await prisma.reconciliationRun.findMany({
      where: { programId: program.id },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('CONFLICT');

    const reservations = await prisma.invoiceReservation.findMany({
      where: { programId: program.id },
    });
    expect(reservations).toHaveLength(0);
  });

  it('records a conflict when reservedAmountMinor does not match the sum of activeReservations', async () => {
    const event = reconciliationEvent({}, [
      { invoiceId: 'INV-1', reservedAmountMinor: 100_000, currency: 'USD' },
    ]);
    event.payload.reservedAmountMinor = 999_999;

    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        event,
        meta(RECONCILIATION_TOPIC, 1n, event),
      ),
    );

    const runs = await prisma.reconciliationRun.findMany({
      where: { externalMessageId: event.messageId },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('CONFLICT');
  });

  it('records a stale reconciliation without applying it', async () => {
    const first = reconciliationEvent({ treasuryVersion: 20 }, [
      { invoiceId: 'INV-1', reservedAmountMinor: 250_000, currency: 'USD' },
    ]);
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        first,
        meta(RECONCILIATION_TOPIC, 1n, first),
      ),
    );
    const stale = reconciliationEvent(
      { treasuryVersion: 15, messageId: uuid() },
      [{ invoiceId: 'INV-1', reservedAmountMinor: 999_999, currency: 'USD' }],
    );
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        stale,
        meta(RECONCILIATION_TOPIC, 2n, stale),
      ),
    );

    const program = await prisma.program.findUniqueOrThrow({
      where: { externalRef: 'PROGRAM-RECON-1' },
    });
    expect(program.reservedAmountMinor).toBe(250_000n);

    const runs = await prisma.reconciliationRun.findMany({
      where: { programId: program.id },
      orderBy: { processedAt: 'asc' },
    });
    expect(runs).toHaveLength(2);
    expect(runs[1].status).toBe('STALE_SKIPPED');
  });

  it('skips a duplicate reconciliation messageId', async () => {
    const event = reconciliationEvent({}, [
      { invoiceId: 'INV-1', reservedAmountMinor: 250_000, currency: 'USD' },
    ]);
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        event,
        meta(RECONCILIATION_TOPIC, 1n, event),
      ),
    );
    await transactionManager.run((client) =>
      reconciliationHandler.handle(
        client,
        event,
        meta(RECONCILIATION_TOPIC, 2n, event),
      ),
    );

    const runs = await prisma.reconciliationRun.findMany({
      where: { externalMessageId: event.messageId },
    });
    expect(runs).toHaveLength(1);
  });
});
