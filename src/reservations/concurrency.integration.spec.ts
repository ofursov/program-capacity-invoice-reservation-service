import { randomUUID as uuid } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { PrismaService } from '../database/prisma.service';
import { ReservationsModule } from './reservations.module';
import { ReservationsService } from './reservations.service';
import {
  cleanBusinessData,
  ensureReferenceData,
} from '../test-support/db-test-utils';

describe('Reservation concurrency (integration)', () => {
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

  it('never over-reserves capacity under concurrent requests', async () => {
    // Program limit: USD 100.00. Ten concurrent requests for USD 30.00 each.
    // Only 3 can succeed (90.00 reserved); the rest must fail with INSUFFICIENT_CAPACITY.
    const program = await prisma.program.create({
      data: {
        externalRef: `PROGRAM-${uuid()}`,
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 10_000n,
      },
    });

    const requests = Array.from({ length: 10 }, (_, index) =>
      service.create({
        programId: program.id,
        invoiceId: `INV-CONC-${index}`,
        invoiceAmountMinor: 3_000,
        invoiceCurrency: 'USD',
      }),
    );

    const results = await Promise.allSettled(requests);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter(
      (r) =>
        r.status === 'rejected' &&
        (r.reason as { code?: string }).code === 'INSUFFICIENT_CAPACITY',
    );

    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(7);

    const updatedProgram = await prisma.program.findUniqueOrThrow({
      where: { id: program.id },
    });
    expect(updatedProgram.reservedAmountMinor).toBe(9_000n);
    expect(
      updatedProgram.reservedAmountMinor <= updatedProgram.totalLimitMinor,
    ).toBe(true);

    const activeReservations = await prisma.invoiceReservation.count({
      where: { programId: program.id, status: 'ACTIVE' },
    });
    expect(activeReservations).toBe(3);
  });
});
