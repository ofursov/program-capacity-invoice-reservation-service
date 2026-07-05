import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PrismaTx } from '../database/prisma-tx.type';
import { InvoiceReservation } from '@prisma/client';

export interface ReservationRow {
  id: string;
  program_id: string;
  invoice_id: string;
  invoice_currency: string;
  invoice_currency_exponent: number;
  invoice_amount_minor: string;
  program_currency: string;
  program_currency_exponent: number;
  reserved_amount_minor: string;
  fx_rate: string;
  fx_rate_source: string;
  fx_rate_valid_at: Date;
  status: string;
  source: string;
  reconciled_at: Date | null;
  reconciliation_message_id: string | null;
  released_at: Date | null;
}

export interface InsertReservationInput {
  programId: string;
  invoiceId: string;
  invoiceCurrency: string;
  invoiceCurrencyExponent: number;
  invoiceAmountMinor: bigint;
  programCurrency: string;
  programCurrencyExponent: number;
  reservedAmountMinor: bigint;
  fxRate: string;
  fxRateSource: string;
  fxRateValidAt: Date;
  source?: string;
  reconciliationMessageId?: string;
}

@Injectable()
export class ReservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByProgramAndInvoice(
    tx: PrismaTx,
    programId: string,
    invoiceId: string,
  ): Promise<ReservationRow | null> {
    const reservation = await tx.invoiceReservation.findFirst({
      where: { programId, invoiceId },
    });
    return reservation ? this.toReservationRow(reservation) : null;
  }

  async insert(
    tx: PrismaTx,
    input: InsertReservationInput,
  ): Promise<ReservationRow> {
    const reservation = await tx.invoiceReservation.create({
      data: {
        programId: input.programId,
        invoiceId: input.invoiceId,
        invoiceCurrency: input.invoiceCurrency,
        invoiceCurrencyExponent: input.invoiceCurrencyExponent,
        invoiceAmountMinor: input.invoiceAmountMinor,
        programCurrency: input.programCurrency,
        programCurrencyExponent: input.programCurrencyExponent,
        reservedAmountMinor: input.reservedAmountMinor,
        fxRate: input.fxRate,
        fxRateSource: input.fxRateSource,
        fxRateValidAt: input.fxRateValidAt,
        status: 'ACTIVE',
        source: input.source ?? 'API',
        reconciliationMessageId: input.reconciliationMessageId ?? null,
      },
    });
    return this.toReservationRow(reservation);
  }

  findById(id: string): Promise<InvoiceReservation | null> {
    return this.prisma.invoiceReservation.findUnique({ where: { id } });
  }

  async findByIdForUpdate(
    tx: PrismaTx,
    id: string,
  ): Promise<ReservationRow | null> {
    const rows = await tx.$queryRaw<ReservationRow[]>`
      SELECT id, program_id, invoice_id, invoice_currency, invoice_currency_exponent,
             invoice_amount_minor::text AS invoice_amount_minor,
             program_currency, program_currency_exponent,
             reserved_amount_minor::text AS reserved_amount_minor,
             fx_rate::text AS fx_rate, fx_rate_source, fx_rate_valid_at,
             status, source, reconciled_at, reconciliation_message_id, released_at
      FROM invoice_reservations
      WHERE id = ${id}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async markReleased(tx: PrismaTx, id: string): Promise<ReservationRow> {
    const reservation = await tx.invoiceReservation.update({
      where: { id },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    return this.toReservationRow(reservation);
  }

  /**
   * Loads every reservation for a program (any status) and locks the rows
   * for the duration of the reconciliation transaction, so the treasury
   * reconciliation handler can upsert/mark them and detect conflicts with
   * already-released reservations safely.
   */
  async findAllForProgramForUpdate(
    tx: PrismaTx,
    programId: string,
  ): Promise<ReservationRow[]> {
    const rows = await tx.$queryRaw<ReservationRow[]>`
      SELECT id, program_id, invoice_id, invoice_currency, invoice_currency_exponent,
             invoice_amount_minor::text AS invoice_amount_minor,
             program_currency, program_currency_exponent,
             reserved_amount_minor::text AS reserved_amount_minor,
             fx_rate::text AS fx_rate, fx_rate_source, fx_rate_valid_at,
             status, source, reconciled_at, reconciliation_message_id, released_at
      FROM invoice_reservations
      WHERE program_id = ${programId}::uuid
      FOR UPDATE
    `;
    return rows;
  }

  async updateFromReconciliation(
    tx: PrismaTx,
    id: string,
    input: {
      reservedAmountMinor: bigint;
      invoiceAmountMinor: bigint;
      invoiceCurrency: string;
      invoiceCurrencyExponent: number;
    },
  ): Promise<ReservationRow> {
    const reservation = await tx.invoiceReservation.update({
      where: { id },
      data: {
        reservedAmountMinor: input.reservedAmountMinor,
        invoiceAmountMinor: input.invoiceAmountMinor,
        invoiceCurrency: input.invoiceCurrency,
        invoiceCurrencyExponent: input.invoiceCurrencyExponent,
        status: 'ACTIVE',
        reconciledAt: null,
      },
    });
    return this.toReservationRow(reservation);
  }

  async markReconciled(
    tx: PrismaTx,
    id: string,
    reconciliationMessageId: string,
  ): Promise<ReservationRow> {
    const reservation = await tx.invoiceReservation.update({
      where: { id },
      data: {
        status: 'RECONCILED',
        reconciledAt: new Date(),
        reconciliationMessageId,
      },
    });
    return this.toReservationRow(reservation);
  }

  private toReservationRow(reservation: InvoiceReservation): ReservationRow {
    return {
      id: reservation.id,
      program_id: reservation.programId,
      invoice_id: reservation.invoiceId,
      invoice_currency: reservation.invoiceCurrency,
      invoice_currency_exponent: reservation.invoiceCurrencyExponent,
      invoice_amount_minor: reservation.invoiceAmountMinor.toString(),
      program_currency: reservation.programCurrency,
      program_currency_exponent: reservation.programCurrencyExponent,
      reserved_amount_minor: reservation.reservedAmountMinor.toString(),
      fx_rate: reservation.fxRate.toString(),
      fx_rate_source: reservation.fxRateSource,
      fx_rate_valid_at: reservation.fxRateValidAt,
      status: reservation.status,
      source: reservation.source,
      reconciled_at: reservation.reconciledAt,
      reconciliation_message_id: reservation.reconciliationMessageId,
      released_at: reservation.releasedAt,
    };
  }
}
