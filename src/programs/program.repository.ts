import { Injectable } from '@nestjs/common';
import { PrismaTx } from '../database/prisma-tx.type';

export interface ProgramRow {
  id: string;
  external_ref: string;
  currency: string;
  currency_exponent: number;
  total_limit_minor: string;
  reserved_amount_minor: string;
  status: string;
  version: string;
}

export interface ProgramTreasuryRow extends ProgramRow {
  treasury_version: string | null;
}

export interface CreateFromTreasuryInput {
  externalRef: string;
  currency: string;
  currencyExponent: number;
  totalLimitMinor: bigint;
  treasuryVersion: bigint;
  occurredAt: Date;
}

export interface ApplyCapacityUpdateInput {
  totalLimitMinor: bigint;
  currency: string;
  currencyExponent: number;
  treasuryVersion: bigint;
  occurredAt: Date;
}

export interface ApplyReconciliationInput {
  totalLimitMinor: bigint;
  reservedAmountMinor: bigint;
  currency: string;
  currencyExponent: number;
  treasuryVersion: bigint;
  occurredAt: Date;
}

@Injectable()
export class ProgramRepository {
  async findById(tx: PrismaTx, programId: string): Promise<ProgramRow | null> {
    const program = await tx.program.findUnique({ where: { id: programId } });
    return program ? this.toProgramRow(program) : null;
  }

  /**
   * Locks the program row for the duration of the caller's transaction.
   * This is the key mechanism preventing two concurrent requests from
   * overspending the same program's capacity: callers must hold this lock
   * while validating and applying reserve/release changes.
   */
  async findByIdForUpdate(
    tx: PrismaTx,
    programId: string,
  ): Promise<ProgramRow | null> {
    const rows = await tx.$queryRaw<ProgramRow[]>`
      SELECT id, external_ref, currency, currency_exponent,
             total_limit_minor::text AS total_limit_minor,
             reserved_amount_minor::text AS reserved_amount_minor,
             status, version::text AS version
      FROM programs
      WHERE id = ${programId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /**
   * Applies a reservation against an already-locked program row (see
   * findByIdForUpdate). Callers must validate available capacity themselves
   * before calling this - the WHERE clause below is a defensive guard, not
   * the primary consistency mechanism.
   */
  async reserveCapacity(
    tx: PrismaTx,
    programId: string,
    amountMinor: bigint,
  ): Promise<ProgramRow | null> {
    const rows = await tx.$queryRaw<ProgramRow[]>`
      UPDATE programs
      SET reserved_amount_minor = reserved_amount_minor + ${amountMinor},
          version = version + 1,
          updated_at = now()
      WHERE id = ${programId}::uuid
        AND status = 'ACTIVE'
        AND total_limit_minor - reserved_amount_minor >= ${amountMinor}
      RETURNING id, external_ref, currency, currency_exponent,
                total_limit_minor::text AS total_limit_minor,
                reserved_amount_minor::text AS reserved_amount_minor,
                status, version::text AS version
    `;
    return rows[0] ?? null;
  }

  /**
   * Applies a release against an already-locked program row (see
   * findByIdForUpdate); callers must lock the program row first.
   */
  async releaseCapacity(
    tx: PrismaTx,
    programId: string,
    amountMinor: bigint,
  ): Promise<ProgramRow> {
    const rows = await tx.$queryRaw<ProgramRow[]>`
      UPDATE programs
      SET reserved_amount_minor = GREATEST(reserved_amount_minor - ${amountMinor}, 0),
          status = CASE
            WHEN GREATEST(reserved_amount_minor - ${amountMinor}, 0) > total_limit_minor THEN 'OVER_LIMIT'
            ELSE 'ACTIVE'
          END,
          version = version + 1,
          updated_at = now()
      WHERE id = ${programId}::uuid
      RETURNING id, external_ref, currency, currency_exponent,
                total_limit_minor::text AS total_limit_minor,
                reserved_amount_minor::text AS reserved_amount_minor,
                status, version::text AS version
    `;
    return rows[0];
  }

  async findByExternalRefForUpdate(
    tx: PrismaTx,
    externalRef: string,
  ): Promise<ProgramTreasuryRow | null> {
    const rows = await tx.$queryRaw<ProgramTreasuryRow[]>`
      SELECT id, external_ref, currency, currency_exponent,
             total_limit_minor::text AS total_limit_minor,
             reserved_amount_minor::text AS reserved_amount_minor,
             status, version::text AS version,
             treasury_version::text AS treasury_version
      FROM programs
      WHERE external_ref = ${externalRef}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async createFromTreasury(
    tx: PrismaTx,
    input: CreateFromTreasuryInput,
  ): Promise<ProgramTreasuryRow> {
    const program = await tx.program.create({
      data: {
        externalRef: input.externalRef,
        currency: input.currency,
        currencyExponent: input.currencyExponent,
        totalLimitMinor: input.totalLimitMinor,
        reservedAmountMinor: 0n,
        status: 'ACTIVE',
        treasuryVersion: input.treasuryVersion,
        lastTreasuryEventAt: input.occurredAt,
      },
    });
    return this.toProgramTreasuryRow(program);
  }

  async applyCapacityUpdate(
    tx: PrismaTx,
    programId: string,
    input: ApplyCapacityUpdateInput,
  ): Promise<ProgramTreasuryRow> {
    const rows = await tx.$queryRaw<ProgramTreasuryRow[]>`
      UPDATE programs
      SET total_limit_minor = ${input.totalLimitMinor},
          currency = ${input.currency},
          currency_exponent = ${input.currencyExponent},
          treasury_version = ${input.treasuryVersion},
          last_treasury_event_at = ${input.occurredAt},
          status = CASE WHEN reserved_amount_minor > ${input.totalLimitMinor} THEN 'OVER_LIMIT' ELSE 'ACTIVE' END,
          version = version + 1,
          updated_at = now()
      WHERE id = ${programId}::uuid
      RETURNING id, external_ref, currency, currency_exponent,
                total_limit_minor::text AS total_limit_minor,
                reserved_amount_minor::text AS reserved_amount_minor,
                status, version::text AS version,
                treasury_version::text AS treasury_version
    `;
    return rows[0];
  }

  async applyReconciliation(
    tx: PrismaTx,
    programId: string,
    input: ApplyReconciliationInput,
  ): Promise<ProgramTreasuryRow> {
    const rows = await tx.$queryRaw<ProgramTreasuryRow[]>`
      UPDATE programs
      SET total_limit_minor = ${input.totalLimitMinor},
          reserved_amount_minor = ${input.reservedAmountMinor},
          currency = ${input.currency},
          currency_exponent = ${input.currencyExponent},
          treasury_version = ${input.treasuryVersion},
          last_treasury_event_at = ${input.occurredAt},
          last_reconciled_at = now(),
          status = CASE WHEN ${input.reservedAmountMinor}::bigint > ${input.totalLimitMinor}::bigint THEN 'OVER_LIMIT' ELSE 'ACTIVE' END,
          version = version + 1,
          updated_at = now()
      WHERE id = ${programId}::uuid
      RETURNING id, external_ref, currency, currency_exponent,
                total_limit_minor::text AS total_limit_minor,
                reserved_amount_minor::text AS reserved_amount_minor,
                status, version::text AS version,
                treasury_version::text AS treasury_version
    `;
    return rows[0];
  }

  private toProgramRow(program: {
    id: string;
    externalRef: string;
    currency: string;
    currencyExponent: number;
    totalLimitMinor: bigint;
    reservedAmountMinor: bigint;
    status: string;
    version: bigint;
  }): ProgramRow {
    return {
      id: program.id,
      external_ref: program.externalRef,
      currency: program.currency,
      currency_exponent: program.currencyExponent,
      total_limit_minor: program.totalLimitMinor.toString(),
      reserved_amount_minor: program.reservedAmountMinor.toString(),
      status: program.status,
      version: program.version.toString(),
    };
  }

  private toProgramTreasuryRow(program: {
    id: string;
    externalRef: string;
    currency: string;
    currencyExponent: number;
    totalLimitMinor: bigint;
    reservedAmountMinor: bigint;
    status: string;
    version: bigint;
    treasuryVersion: bigint | null;
  }): ProgramTreasuryRow {
    return {
      ...this.toProgramRow(program),
      treasury_version: program.treasuryVersion?.toString() ?? null,
    };
  }
}
