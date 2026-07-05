import { randomUUID as uuid } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { HttpExceptionFilter } from './../src/common/errors/http-exception.filter';
import { PrismaService } from '../src/database/prisma.service';
import {
  cleanBusinessData,
  ensureReferenceData,
} from '../src/test-support/db-test-utils';

interface ErrorResponseBody {
  code: string;
}

describe('AppModule auth guard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    await ensureReferenceData(prisma);
  });

  afterAll(async () => {
    await cleanBusinessData(prisma);
    await app.close();
  });

  async function createProgram() {
    return prisma.program.create({
      data: {
        externalRef: `PROGRAM-AUTH-${uuid()}`,
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 1_000_000_000n,
      },
    });
  }

  it('/health/live (GET) is public and returns ok', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('rejects a protected endpoint without a bearer token', async () => {
    const program = await createProgram();
    return request(app.getHttpServer())
      .get(`/v1/programs/${program.id}/availability`)
      .expect(401)
      .expect((res) => {
        expect((res.body as ErrorResponseBody).code).toBe('UNAUTHORIZED');
      });
  });

  it('accepts a valid token with the required scope', async () => {
    const program = await createProgram();
    const jwtService = app.get(JwtService);
    const token = await jwtService.signAsync(
      { scope: 'capacity:read' },
      { subject: 'local-user-1' },
    );

    return request(app.getHttpServer())
      .get(`/v1/programs/${program.id}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects a valid token missing the required scope', async () => {
    const program = await createProgram();
    const jwtService = app.get(JwtService);
    const token = await jwtService.signAsync(
      { scope: 'other:scope' },
      { subject: 'local-user-1' },
    );

    return request(app.getHttpServer())
      .get(`/v1/programs/${program.id}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
      .expect((res) => {
        expect((res.body as ErrorResponseBody).code).toBe('FORBIDDEN');
      });
  });
});
