import { randomUUID as uuid } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { PrismaService } from '../database/prisma.service';
import { ReservationsModule } from './reservations.module';
import { ReservationsService } from './reservations.service';
import { LedgerRepository } from '../audit/ledger.repository';
import {
  cleanBusinessData,
  ensureReferenceData,
} from '../test-support/db-test-utils';

describe('ReservationsService (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: ReservationsService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule, ReservationsModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(ReservationsService);
    await ensureReferenceData(prisma);
  });

  afterAll(async () => {
    await cleanBusinessData(prisma);
    await moduleRef.close();
  });

  afterEach(async () => {
    await cleanBusinessData(prisma);
  });

  async function createProgram(
    overrides: Partial<{
      currency: string;
      currencyExponent: number;
      totalLimitMinor: bigint;
    }> = {},
  ) {
    return prisma.program.create({
      data: {
        externalRef: `PROGRAM-${uuid()}`,
        currency: overrides.currency ?? 'USD',
        currencyExponent: overrides.currencyExponent ?? 2,
        totalLimitMinor: overrides.totalLimitMinor ?? 1_000_000_000n,
      },
    });
  }

  it('creates a reservation and reduces available capacity in the same currency', async () => {
    const program = await createProgram();

    const body = await service.create({
      programId: program.id,
      invoiceId: 'INV-1',
      invoiceAmountMinor: 10_000_000,
      invoiceCurrency: 'USD',
    });

    expect(body.status).toBe('ACTIVE');
    expect(body.reservedAmountMinor).toBe(10_000_000);
    expect(body.availableAmountMinor).toBe(990_000_000);

    const updatedProgram = await prisma.program.findUniqueOrThrow({
      where: { id: program.id },
    });
    expect(updatedProgram.reservedAmountMinor).toBe(10_000_000n);

    const ledgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { programId: program.id },
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].eventType).toBe('RESERVATION_CREATED');
    expect(ledgerEntries[0].amountMinor).toBe(10_000_000n);
  });

  it('converts multi-currency reservations using the FX snapshot and exponents', async () => {
    const program = await createProgram({
      currency: 'USD',
      currencyExponent: 2,
    });

    // EUR 100,000.00 at 1.08 -> USD 108,000.00
    const body = await service.create({
      programId: program.id,
      invoiceId: 'INV-EUR',
      invoiceAmountMinor: 10_000_000,
      invoiceCurrency: 'EUR',
    });

    expect(body.reservedAmountMinor).toBe(10_800_000);
    expect(body.fxRate).toBe('1.0800000000');
  });

  it('returns INSUFFICIENT_CAPACITY when the program lacks room', async () => {
    const program = await createProgram({ totalLimitMinor: 5_000_000n });

    await expect(
      service.create({
        programId: program.id,
        invoiceId: 'INV-BIG',
        invoiceAmountMinor: 10_000_000,
        invoiceCurrency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CAPACITY' });

    const updatedProgram = await prisma.program.findUniqueOrThrow({
      where: { id: program.id },
    });
    expect(updatedProgram.reservedAmountMinor).toBe(0n);

    const reservations = await prisma.invoiceReservation.findMany({
      where: { programId: program.id },
    });
    expect(reservations).toHaveLength(0);

    const ledgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { programId: program.id },
    });
    expect(ledgerEntries).toHaveLength(0);
  });

  it('rejects a duplicate invoice on the same program', async () => {
    const program = await createProgram();
    const dto = {
      programId: program.id,
      invoiceId: 'INV-DUP',
      invoiceAmountMinor: 1_000_000,
      invoiceCurrency: 'USD',
    };

    const first = await service.create(dto);
    expect(first.status).toBe('ACTIVE');

    await expect(service.create(dto)).rejects.toMatchObject({
      code: 'INVOICE_ALREADY_RESERVED',
    });

    const reservations = await prisma.invoiceReservation.findMany({
      where: { programId: program.id },
    });
    expect(reservations).toHaveLength(1);

    const updatedProgram = await prisma.program.findUniqueOrThrow({
      where: { id: program.id },
    });
    expect(updatedProgram.reservedAmountMinor).toBe(1_000_000n);
  });

  it('fully releases a reservation and restores capacity', async () => {
    const program = await createProgram();
    const created = await service.create({
      programId: program.id,
      invoiceId: 'INV-REL',
      invoiceAmountMinor: 4_000_000,
      invoiceCurrency: 'USD',
    });

    const released = await service.release(created.reservationId);
    expect(released.status).toBe('RELEASED');
    expect(released.releasedAmountMinor).toBe(4_000_000);

    const updatedProgram = await prisma.program.findUniqueOrThrow({
      where: { id: program.id },
    });
    expect(updatedProgram.reservedAmountMinor).toBe(0n);

    const reservation = await prisma.invoiceReservation.findUniqueOrThrow({
      where: { id: created.reservationId },
    });
    expect(reservation.status).toBe('RELEASED');

    const ledgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { programId: program.id, eventType: 'RESERVATION_RELEASED' },
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].amountMinor).toBe(-4_000_000n);
  });

  it('is idempotent when releasing an already-released reservation', async () => {
    const program = await createProgram();
    const created = await service.create({
      programId: program.id,
      invoiceId: 'INV-REL-2',
      invoiceAmountMinor: 4_000_000,
      invoiceCurrency: 'USD',
    });

    await service.release(created.reservationId);
    const secondRelease = await service.release(created.reservationId);

    expect(secondRelease.status).toBe('RELEASED');

    const updatedProgram = await prisma.program.findUniqueOrThrow({
      where: { id: program.id },
    });
    expect(updatedProgram.reservedAmountMinor).toBe(0n);

    const releaseLedgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { programId: program.id, eventType: 'RESERVATION_RELEASED' },
    });
    expect(releaseLedgerEntries).toHaveLength(1);
  });

  it('rolls back the whole transaction when a later write fails', async () => {
    const program = await createProgram({ totalLimitMinor: 10_000_000n });
    const ledgerRepository = moduleRef.get(LedgerRepository);
    const spy = jest
      .spyOn(ledgerRepository, 'insert')
      .mockRejectedValueOnce(new Error('simulated ledger write failure'));

    await expect(
      service.create({
        programId: program.id,
        invoiceId: 'INV-ROLLBACK',
        invoiceAmountMinor: 1_000_000,
        invoiceCurrency: 'USD',
      }),
    ).rejects.toThrow('simulated ledger write failure');

    spy.mockRestore();

    const updatedProgram = await prisma.program.findUniqueOrThrow({
      where: { id: program.id },
    });
    expect(updatedProgram.reservedAmountMinor).toBe(0n);

    const reservations = await prisma.invoiceReservation.findMany({
      where: { programId: program.id },
    });
    expect(reservations).toHaveLength(0);

    const ledgerEntries = await prisma.capacityLedgerEntry.findMany({
      where: { programId: program.id },
    });
    expect(ledgerEntries).toHaveLength(0);
  });

  it('rejects releasing a reservation superseded by treasury reconciliation', async () => {
    const program = await createProgram();
    const created = await service.create({
      programId: program.id,
      invoiceId: 'INV-RECON',
      invoiceAmountMinor: 4_000_000,
      invoiceCurrency: 'USD',
    });

    await prisma.invoiceReservation.update({
      where: { id: created.reservationId },
      data: { status: 'RECONCILED', reconciledAt: new Date() },
    });

    await expect(service.release(created.reservationId)).rejects.toMatchObject({
      code: 'RECONCILIATION_CONFLICT',
    });
  });
});
