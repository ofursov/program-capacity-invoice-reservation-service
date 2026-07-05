export const CAPACITY_UPDATE_TOPIC = 'treasury.program-capacity-updated.v1';
export const RECONCILIATION_TOPIC = 'treasury.program-reconciliation.v1';
export const TREASURY_TOPICS = [CAPACITY_UPDATE_TOPIC, RECONCILIATION_TOPIC];

export interface TreasuryActiveReservation {
  invoiceId: string;
  reservationId?: string;
  reservedAmountMinor: number;
  currency: string;
}

export interface TreasuryCapacityUpdatePayload {
  currency: string;
  currencyExponent: number;
  totalLimitMinor: number;
}

export interface TreasuryReconciliationPayload
  extends TreasuryCapacityUpdatePayload {
  reservedAmountMinor: number;
  activeReservations: TreasuryActiveReservation[];
}

export interface TreasuryCapacityUpdateEvent {
  messageId: string;
  type: 'PROGRAM_CAPACITY_UPDATED';
  programExternalRef: string;
  treasuryVersion: number;
  occurredAt: string;
  payload: TreasuryCapacityUpdatePayload;
}

export interface TreasuryReconciliationEvent {
  messageId: string;
  type: 'PROGRAM_RECONCILIATION';
  programExternalRef: string;
  treasuryVersion: number;
  occurredAt: string;
  payload: TreasuryReconciliationPayload;
}

export type TreasuryEvent =
  TreasuryCapacityUpdateEvent | TreasuryReconciliationEvent;

export class TreasuryMessageValidationError extends Error {}

function assertNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TreasuryMessageValidationError(
      `${field} must be a non-empty string.`,
    );
  }
}

function assertFiniteNumber(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TreasuryMessageValidationError(
      `${field} must be a finite number.`,
    );
  }
}

function parseActiveReservations(
  value: unknown,
): TreasuryActiveReservation[] {
  if (!Array.isArray(value)) {
    throw new TreasuryMessageValidationError(
      'payload.activeReservations must be an array.',
    );
  }
  return value.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new TreasuryMessageValidationError(
        `payload.activeReservations[${index}] must be an object.`,
      );
    }
    const item = raw as Record<string, unknown>;
    assertNonEmptyString(
      item.invoiceId,
      `payload.activeReservations[${index}].invoiceId`,
    );
    assertFiniteNumber(
      item.reservedAmountMinor,
      `payload.activeReservations[${index}].reservedAmountMinor`,
    );
    assertNonEmptyString(
      item.currency,
      `payload.activeReservations[${index}].currency`,
    );
    if (
      item.reservationId !== undefined &&
      typeof item.reservationId !== 'string'
    ) {
      throw new TreasuryMessageValidationError(
        `payload.activeReservations[${index}].reservationId must be a string when present.`,
      );
    }
    return {
      invoiceId: item.invoiceId,
      reservationId: item.reservationId as string | undefined,
      reservedAmountMinor: item.reservedAmountMinor,
      currency: item.currency,
    };
  });
}

export function parseTreasuryEvent(raw: unknown): TreasuryEvent {
  if (typeof raw !== 'object' || raw === null) {
    throw new TreasuryMessageValidationError(
      'Treasury message body must be a JSON object.',
    );
  }
  const obj = raw as Record<string, unknown>;

  assertNonEmptyString(obj.messageId, 'messageId');
  assertNonEmptyString(obj.programExternalRef, 'programExternalRef');
  assertFiniteNumber(obj.treasuryVersion, 'treasuryVersion');
  assertNonEmptyString(obj.occurredAt, 'occurredAt');
  if (Number.isNaN(Date.parse(obj.occurredAt))) {
    throw new TreasuryMessageValidationError(
      'occurredAt must be a valid ISO 8601 timestamp.',
    );
  }

  if (
    obj.type !== 'PROGRAM_CAPACITY_UPDATED' &&
    obj.type !== 'PROGRAM_RECONCILIATION'
  ) {
    throw new TreasuryMessageValidationError(
      `Unsupported treasury message type: ${String(obj.type)}`,
    );
  }

  if (typeof obj.payload !== 'object' || obj.payload === null) {
    throw new TreasuryMessageValidationError('payload must be an object.');
  }
  const payload = obj.payload as Record<string, unknown>;

  assertNonEmptyString(payload.currency, 'payload.currency');
  assertFiniteNumber(payload.currencyExponent, 'payload.currencyExponent');
  assertFiniteNumber(payload.totalLimitMinor, 'payload.totalLimitMinor');

  if (obj.type === 'PROGRAM_RECONCILIATION') {
    assertFiniteNumber(
      payload.reservedAmountMinor,
      'payload.reservedAmountMinor',
    );
    payload.activeReservations = parseActiveReservations(
      payload.activeReservations,
    );
  }

  return obj as unknown as TreasuryEvent;
}
