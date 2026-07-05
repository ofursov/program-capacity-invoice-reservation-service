import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PrismaService } from '../database/prisma.service';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';

export interface ResolvedFxRate {
  rate: Decimal;
  source: string;
  validAt: Date;
}

const IDENTITY_RATE_SOURCE = 'IDENTITY';

@Injectable()
export class FxService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveRate(
    baseCurrency: string,
    quoteCurrency: string,
  ): Promise<ResolvedFxRate> {
    if (baseCurrency === quoteCurrency) {
      return {
        rate: new Decimal(1),
        source: IDENTITY_RATE_SOURCE,
        validAt: new Date(),
      };
    }

    const fxRate = await this.prisma.fxRate.findFirst({
      where: { baseCurrency, quoteCurrency },
      orderBy: { validAt: 'desc' },
    });

    if (!fxRate) {
      throw new AppError(
        ErrorCode.FX_RATE_NOT_FOUND,
        `No FX rate available for ${baseCurrency} -> ${quoteCurrency}.`,
        { baseCurrency, quoteCurrency },
      );
    }

    return {
      rate: new Decimal(fxRate.rate.toString()),
      source: fxRate.source,
      validAt: fxRate.validAt,
    };
  }
}
