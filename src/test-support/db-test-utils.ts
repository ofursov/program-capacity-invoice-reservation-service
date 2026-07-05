import { PrismaClient } from '@prisma/client';

export const TEST_CURRENCIES: { code: string; exponent: number }[] = [
  { code: 'USD', exponent: 2 },
  { code: 'EUR', exponent: 2 },
  { code: 'JPY', exponent: 0 },
  { code: 'KWD', exponent: 3 },
];

export const TEST_FX_SOURCE = 'test-fixture';

export const TEST_FX_RATES: { base: string; quote: string; rate: string }[] = [
  { base: 'EUR', quote: 'USD', rate: '1.08' },
  { base: 'JPY', quote: 'USD', rate: '0.0067' },
];

export async function ensureReferenceData(prisma: PrismaClient): Promise<void> {
  for (const currency of TEST_CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      create: currency,
      update: { exponent: currency.exponent },
    });
  }

  await prisma.fxRate.deleteMany({ where: { source: TEST_FX_SOURCE } });
  await prisma.fxRate.createMany({
    data: TEST_FX_RATES.map((fx) => ({
      baseCurrency: fx.base,
      quoteCurrency: fx.quote,
      rate: fx.rate,
      source: TEST_FX_SOURCE,
      validAt: new Date(),
    })),
  });
}

export async function cleanBusinessData(prisma: PrismaClient): Promise<void> {
  // Cast to any to avoid unsafe-call/type resolution issues from the ESLint rule
  const p = prisma as unknown as any;
  await p.$transaction([
    p.capacityLedgerEntry.deleteMany(),
    p.reconciliationRun.deleteMany(),
    p.invoiceReservation.deleteMany(),
    p.processedKafkaMessage.deleteMany(),
    p.program.deleteMany(),
  ]);
}
