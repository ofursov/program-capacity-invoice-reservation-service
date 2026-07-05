import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';

@Injectable()
export class CurrencyMetadataService {
  constructor(private readonly prisma: PrismaService) {}

  async getExponent(currencyCode: string): Promise<number> {
    const currency = await this.prisma.currency.findUnique({
      where: { code: currencyCode },
    });
    if (!currency) {
      throw new AppError(
        ErrorCode.UNSUPPORTED_CURRENCY,
        `Currency ${currencyCode} is not supported.`,
        { currency: currencyCode },
      );
    }
    return currency.exponent;
  }
}
