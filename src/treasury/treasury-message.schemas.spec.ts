import {
  parseTreasuryEvent,
  TreasuryMessageValidationError,
} from './treasury-message.schemas';

function validCapacityUpdate() {
  return {
    messageId: 'msg-001',
    type: 'PROGRAM_CAPACITY_UPDATED',
    programExternalRef: 'PROGRAM-ABC',
    treasuryVersion: 101,
    occurredAt: '2026-07-02T10:00:00.000Z',
    payload: {
      currency: 'USD',
      currencyExponent: 2,
      totalLimitMinor: 1000000000,
    },
  };
}

function validReconciliation() {
  return {
    messageId: 'recon-001',
    type: 'PROGRAM_RECONCILIATION',
    programExternalRef: 'PROGRAM-ABC',
    treasuryVersion: 150,
    occurredAt: '2026-07-02T11:00:00.000Z',
    payload: {
      currency: 'USD',
      currencyExponent: 2,
      totalLimitMinor: 1000000000,
      reservedAmountMinor: 250000000,
      activeReservations: [
        { invoiceId: 'INV-1', reservedAmountMinor: 100000000, currency: 'USD' },
        { invoiceId: 'INV-2', reservedAmountMinor: 150000000, currency: 'USD' },
      ],
    },
  };
}

describe('parseTreasuryEvent', () => {
  it('accepts a valid capacity update event', () => {
    const event = parseTreasuryEvent(validCapacityUpdate());
    expect(event.type).toBe('PROGRAM_CAPACITY_UPDATED');
  });

  it('accepts a valid reconciliation event', () => {
    const event = parseTreasuryEvent(validReconciliation());
    expect(event.type).toBe('PROGRAM_RECONCILIATION');
  });

  it('rejects a reconciliation event missing reservedAmountMinor', () => {
    const raw = validReconciliation();
    delete (raw.payload as Record<string, unknown>).reservedAmountMinor;
    expect(() => parseTreasuryEvent(raw)).toThrow(
      TreasuryMessageValidationError,
    );
  });

  it('rejects a reconciliation event with a non-array activeReservations', () => {
    const raw = validReconciliation();
    (raw.payload as Record<string, unknown>).activeReservations = 'not-an-array';
    expect(() => parseTreasuryEvent(raw)).toThrow(
      TreasuryMessageValidationError,
    );
  });

  it('rejects an activeReservations item missing invoiceId', () => {
    const raw = validReconciliation();
    raw.payload.activeReservations = [
      { reservedAmountMinor: 100, currency: 'USD' } as never,
    ];
    expect(() => parseTreasuryEvent(raw)).toThrow(
      TreasuryMessageValidationError,
    );
  });

  it('rejects an unsupported message type', () => {
    const raw = { ...validCapacityUpdate(), type: 'SOMETHING_ELSE' };
    expect(() => parseTreasuryEvent(raw)).toThrow(
      TreasuryMessageValidationError,
    );
  });

  it('rejects a missing messageId', () => {
    const raw = validCapacityUpdate() as Record<string, unknown>;
    delete raw.messageId;
    expect(() => parseTreasuryEvent(raw)).toThrow(
      TreasuryMessageValidationError,
    );
  });

  it('rejects a non-ISO occurredAt', () => {
    const raw = { ...validCapacityUpdate(), occurredAt: 'not-a-date' };
    expect(() => parseTreasuryEvent(raw)).toThrow(
      TreasuryMessageValidationError,
    );
  });

  it('rejects a non-object payload', () => {
    const raw = null;
    expect(() => parseTreasuryEvent(raw)).toThrow(
      TreasuryMessageValidationError,
    );
  });

  it('rejects a missing payload object', () => {
    const raw = { ...validCapacityUpdate(), payload: undefined };
    expect(() => parseTreasuryEvent(raw)).toThrow(
      TreasuryMessageValidationError,
    );
  });
});
