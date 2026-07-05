import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { bigIntToSafeNumber } from '../fx/money';
import { ProgramAvailabilityResponse } from './dto/program-availability.response';

@Injectable()
export class ProgramsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAvailability(
    programId: string,
  ): Promise<ProgramAvailabilityResponse> {
    const program = await this.prisma.program.findUnique({
      where: { id: programId },
    });
    if (!program) {
      throw new AppError(ErrorCode.PROGRAM_NOT_FOUND, 'Program not found.', {
        programId,
      });
    }

    const availableAmountMinor =
      program.reservedAmountMinor > program.totalLimitMinor
        ? 0n
        : program.totalLimitMinor - program.reservedAmountMinor;
    const overReservedAmountMinor =
      program.reservedAmountMinor > program.totalLimitMinor
        ? program.reservedAmountMinor - program.totalLimitMinor
        : 0n;

    return {
      programId: program.id,
      externalRef: program.externalRef,
      currency: program.currency,
      totalLimitMinor: bigIntToSafeNumber(program.totalLimitMinor),
      reservedAmountMinor: bigIntToSafeNumber(program.reservedAmountMinor),
      availableAmountMinor: bigIntToSafeNumber(availableAmountMinor),
      overReservedAmountMinor: bigIntToSafeNumber(overReservedAmountMinor),
      status: program.status,
      version: bigIntToSafeNumber(program.version),
      lastReconciledAt: program.lastReconciledAt,
    };
  }
}
