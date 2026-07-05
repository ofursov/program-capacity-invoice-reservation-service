import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PrismaTx } from './prisma-tx.type';

@Injectable()
export class TransactionManager {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(work: (tx: PrismaTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }
}
