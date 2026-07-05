import { PrismaClient } from '@prisma/client';

const SEED_FX_SOURCE = 'seed-script';

const CURRENCIES: { code: string; exponent: number }[] = [
  { code: 'USD', exponent: 2 },
  { code: 'EUR', exponent: 2 },
  { code: 'GBP', exponent: 2 },
  { code: 'JPY', exponent: 0 },
  { code: 'KWD', exponent: 3 },
];

const FX_RATES: { base: string; quote: string; rate: string }[] = [
  { base: 'EUR', quote: 'USD', rate: '1.08' },
  { base: 'GBP', quote: 'USD', rate: '1.25' },
  { base: 'JPY', quote: 'USD', rate: '0.0067' },
  { base: 'KWD', quote: 'USD', rate: '3.25' },
];

async function main() {
  const prisma = new PrismaClient();

  try {
    for (const currency of CURRENCIES) {
      await prisma.currency.upsert({
        where: { code: currency.code },
        create: currency,
        update: { exponent: currency.exponent },
      });
    }

    await prisma.fxRate.deleteMany({ where: { source: SEED_FX_SOURCE } });
    await prisma.fxRate.createMany({
      data: FX_RATES.map((fx) => ({
        baseCurrency: fx.base,
        quoteCurrency: fx.quote,
        rate: fx.rate,
        source: SEED_FX_SOURCE,
        validAt: new Date(),
      })),
    });

    const program = await prisma.program.upsert({
      where: { externalRef: 'PROGRAM-ABC' },
      create: {
        externalRef: 'PROGRAM-ABC',
        currency: 'USD',
        currencyExponent: 2,
        totalLimitMinor: 1_000_000_000n,
      },
      update: {},
    });

    console.log('Seed complete.');
    console.log(`Currencies: ${CURRENCIES.map((c) => c.code).join(', ')}`);
    console.log(`FX rates: ${FX_RATES.length} pairs seeded from ${SEED_FX_SOURCE}`);
    console.log(
      `Demo program: ${program.externalRef} (${program.id}), limit ${program.totalLimitMinor} ${program.currency} minor units`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
