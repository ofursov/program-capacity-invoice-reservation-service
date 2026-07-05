import { randomUUID as uuid } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/errors/http-exception.filter';
import { PrismaService } from '../src/database/prisma.service';
import {
  cleanBusinessData,
  ensureReferenceData,
} from '../src/test-support/db-test-utils';

interface ReservationBody {
  reservationId: string;
  status: string;
  reservedAmountMinor: number;
}

interface AvailabilityBody {
  reservedAmountMinor: number;
  availableAmountMinor: number;
}

interface ErrorResponseBody {
  code: string;
}

describe('Reservations API (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    await ensureReferenceData(prisma);

    const jwtService = app.get(JwtService);
    token = await jwtService.signAsync(
      { scope: 'capacity:read capacity:write' },
      { subject: 'e2e-test-user' },
    );
  }, 30_000);

  afterAll(async () => {
    await cleanBusinessData(prisma);
    await app.close();
  });

  async function createProgram() {
    return prisma.program.create({
      data: {
        externalRef: `PROGRAM-E2E-${uuid()}`,
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 1_000_000_000n,
      },
    });
  }

  it('runs the full reserve -> availability -> release -> reserve -> release flow', async () => {
    const program = await createProgram();

    const createRes = await request(app.getHttpServer())
      .post('/v1/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        programId: program.id,
        invoiceId: 'INV-E2E-1',
        invoiceAmountMinor: 10_000_000,
        invoiceCurrency: 'USD',
      })
      .expect(201);

    const createBody = createRes.body as ReservationBody;
    expect(createBody.status).toBe('ACTIVE');
    expect(createBody.reservedAmountMinor).toBe(10_000_000);
    const reservationId = createBody.reservationId;

    const availabilityAfterCreate = await request(app.getHttpServer())
      .get(`/v1/programs/${program.id}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const availabilityAfterCreateBody =
      availabilityAfterCreate.body as AvailabilityBody;
    expect(availabilityAfterCreateBody.reservedAmountMinor).toBe(10_000_000);
    expect(availabilityAfterCreateBody.availableAmountMinor).toBe(990_000_000);

    await request(app.getHttpServer())
      .post(`/v1/reservations/${reservationId}/release`)
      .set('Authorization', `Bearer ${token}`)
      .send()
      .expect(201)
      .expect((res) => {
        expect((res.body as ReservationBody).status).toBe('RELEASED');
      });

    const availabilityAfterRelease = await request(app.getHttpServer())
      .get(`/v1/programs/${program.id}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (availabilityAfterRelease.body as AvailabilityBody).reservedAmountMinor,
    ).toBe(0);

    const secondReserve = await request(app.getHttpServer())
      .post('/v1/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        programId: program.id,
        invoiceId: 'INV-E2E-2',
        invoiceAmountMinor: 5_000_000,
        invoiceCurrency: 'USD',
      })
      .expect(201);
    const secondReservationId = (secondReserve.body as ReservationBody)
      .reservationId;

    await request(app.getHttpServer())
      .post(`/v1/reservations/${secondReservationId}/release`)
      .set('Authorization', `Bearer ${token}`)
      .send()
      .expect(201)
      .expect((res) => {
        expect((res.body as ReservationBody).status).toBe('RELEASED');
      });

    const finalAvailability = await request(app.getHttpServer())
      .get(`/v1/programs/${program.id}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (finalAvailability.body as AvailabilityBody).reservedAmountMinor,
    ).toBe(0);
  });

  it('rejects requests without a bearer token', async () => {
    const program = await createProgram();
    await request(app.getHttpServer())
      .get(`/v1/programs/${program.id}/availability`)
      .expect(401)
      .expect((res) => {
        expect((res.body as ErrorResponseBody).code).toBe('UNAUTHORIZED');
      });
  });

  it('returns 409 for insufficient capacity', async () => {
    const program = await prisma.program.create({
      data: {
        externalRef: `PROGRAM-E2E-SMALL-${uuid()}`,
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 1_000n,
      },
    });

    await request(app.getHttpServer())
      .post('/v1/reservations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        programId: program.id,
        invoiceId: 'INV-TOO-BIG',
        invoiceAmountMinor: 10_000,
        invoiceCurrency: 'USD',
      })
      .expect(409)
      .expect((res) => {
        expect((res.body as ErrorResponseBody).code).toBe(
          'INSUFFICIENT_CAPACITY',
        );
      });
  });
});
