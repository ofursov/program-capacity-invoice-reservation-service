import { Test } from '@nestjs/testing';
import { ProgramsService } from './programs.service';
import { PrismaService } from '../database/prisma.service';
import { ErrorCode } from '../common/errors/error-codes';

describe('ProgramsService', () => {
  let service: ProgramsService;
  const findUnique = jest.fn();

  beforeEach(async () => {
    findUnique.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProgramsService,
        {
          provide: PrismaService,
          useValue: { program: { findUnique } },
        },
      ],
    }).compile();

    service = moduleRef.get(ProgramsService);
  });

  it('throws PROGRAM_NOT_FOUND when the program does not exist', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.getAvailability('missing-id')).rejects.toMatchObject({
      code: ErrorCode.PROGRAM_NOT_FOUND,
    });
  });

  it('computes available capacity when under the limit', async () => {
    findUnique.mockResolvedValue({
      id: 'p1',
      externalRef: 'PROGRAM-ABC',
      currency: 'USD',
      totalLimitMinor: 1_000_000_000n,
      reservedAmountMinor: 10_800_000n,
      status: 'ACTIVE',
      version: 42n,
      lastReconciledAt: null,
    });

    const result = await service.getAvailability('p1');

    expect(result.availableAmountMinor).toBe(989_200_000);
    expect(result.overReservedAmountMinor).toBe(0);
  });

  it('computes over-reserved amount when reserved exceeds the limit', async () => {
    findUnique.mockResolvedValue({
      id: 'p1',
      externalRef: 'PROGRAM-ABC',
      currency: 'USD',
      totalLimitMinor: 1_000_000n,
      reservedAmountMinor: 1_200_000n,
      status: 'OVER_LIMIT',
      version: 5n,
      lastReconciledAt: null,
    });

    const result = await service.getAvailability('p1');

    expect(result.availableAmountMinor).toBe(0);
    expect(result.overReservedAmountMinor).toBe(200_000);
    expect(result.status).toBe('OVER_LIMIT');
  });
});
