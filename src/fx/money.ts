import Decimal from 'decimal.js';

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

export function convertMinorUnits(
  amountMinor: bigint,
  sourceExponent: number,
  targetExponent: number,
  rate: Decimal.Value,
): bigint {
  const sourceMajor = new Decimal(amountMinor.toString()).dividedBy(
    new Decimal(10).pow(sourceExponent),
  );
  const targetMajor = sourceMajor.times(rate);
  const targetMinor = targetMajor
    .times(new Decimal(10).pow(targetExponent))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

  return BigInt(targetMinor.toFixed(0));
}

export function bigIntToSafeNumber(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError(
      `Value ${value.toString()} exceeds safe integer range for JSON number serialization.`,
    );
  }
  return Number(value);
}
