import { bigIntToSafeNumber, convertMinorUnits } from './money';

describe('convertMinorUnits', () => {
  it('converts between currencies with equal exponents', () => {
    // EUR 100.00 -> USD at 1.08 -> USD 108.00
    const result = convertMinorUnits(10000n, 2, 2, '1.08');
    expect(result).toBe(10800n);
  });

  it('converts JPY (0 exponent) to USD (2 exponent) correctly', () => {
    // JPY 10,000 -> USD at 0.0067 -> USD 67.00
    const result = convertMinorUnits(10000n, 0, 2, '0.0067');
    expect(result).toBe(6700n);
  });

  it('converts USD (2 exponent) to JPY (0 exponent) correctly', () => {
    // USD 100.00 -> JPY at 149.25 -> JPY 14,925
    const result = convertMinorUnits(10000n, 2, 0, '149.25');
    expect(result).toBe(14925n);
  });

  it('applies HALF_UP rounding at the target minor unit', () => {
    // 10.005 major units (source exponent 3) -> target exponent 2 -> 10.01
    const result = convertMinorUnits(10005n, 3, 2, '1');
    expect(result).toBe(1001n);
  });

  it('rounds down when below the half-way point', () => {
    // 10.004 -> 10.00
    const result = convertMinorUnits(10004n, 3, 2, '1');
    expect(result).toBe(1000n);
  });

  it('handles an identity rate with equal exponents', () => {
    const result = convertMinorUnits(500n, 2, 2, '1');
    expect(result).toBe(500n);
  });
});

describe('bigIntToSafeNumber', () => {
  it('converts an in-range bigint to a number', () => {
    expect(bigIntToSafeNumber(10800n)).toBe(10800);
  });

  it('throws when the value exceeds MAX_SAFE_INTEGER', () => {
    const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => bigIntToSafeNumber(tooLarge)).toThrow(RangeError);
  });

  it('throws when the value is below MIN_SAFE_INTEGER', () => {
    const tooSmall = BigInt(Number.MIN_SAFE_INTEGER) - 1n;
    expect(() => bigIntToSafeNumber(tooSmall)).toThrow(RangeError);
  });
});
