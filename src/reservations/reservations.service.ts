import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { PrismaTx } from '../database/prisma-tx.type';
import { TransactionManager } from '../database/transaction-manager';
import { ProgramRepository, ProgramRow } from '../programs/program.repository';
import {
  ReservationRepository,
  ReservationRow,
} from './reservation.repository';
import { LedgerRepository } from '../audit/ledger.repository';
import { FxService } from '../fx/fx.service';
import { CurrencyMetadataService } from '../fx/currency-metadata.service';
import { convertMinorUnits, bigIntToSafeNumber } from '../fx/money';
import { ErrorCode } from '../common/errors/error-codes';
import { CreateReservationRequest } from './dto/create-reservation.request';
import { ReservationResponse } from './dto/reservation.response';
import { ReservationDetailResponse } from './dto/reservation-detail.response';
import { ReleaseReservationResponse } from './dto/release-reservation.response';
import { AppError } from '../common/errors/app-error';

export interface ServiceResult<T> {
  httpStatus: number;
  body: T;
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly transactionManager: TransactionManager,
    private readonly programRepository: ProgramRepository,
    private readonly reservationRepository: ReservationRepository,
    private readonly ledgerRepository: LedgerRepository,
    private readonly fxService: FxService,
    private readonly currencyMetadataService: CurrencyMetadataService,
  ) {}

  async create(dto: CreateReservationRequest): Promise<ReservationResponse> {
    return await this.transactionManager.run((client) =>
      this.runReservationTransaction(client, dto),
    );
  }

  private async runReservationTransaction(
    client: PrismaTx,
    dto: CreateReservationRequest,
  ): Promise<ReservationResponse> {
    const program = await this.programRepository.findByIdForUpdate(
      client,
      dto.programId,
    );
    if (!program) {
      throw new AppError(ErrorCode.PROGRAM_NOT_FOUND, 'Program not found.', {
        programId: dto.programId,
      });
    }

    if (program.status !== 'ACTIVE') {
      const code =
        program.status === 'OVER_LIMIT'
          ? ErrorCode.PROGRAM_OVER_LIMIT
          : ErrorCode.PROGRAM_NOT_ACTIVE;
      throw new AppError(code, 'Program not active.', {
        programId: dto.programId,
      });
    }

    const existingReservation =
      await this.reservationRepository.findByProgramAndInvoice(
        client,
        program.id,
        dto.invoiceId,
      );
    if (existingReservation) {
      const code =
        existingReservation.status === 'ACTIVE'
          ? ErrorCode.INVOICE_ALREADY_RESERVED
          : ErrorCode.INVOICE_ALREADY_PROCESSED;
      throw new AppError(
        code,
        'This invoice already has a reservation on this program.',
        {
          invoiceId: dto.invoiceId,
          programId: dto.programId,
        },
      );
    }

    const invoiceCurrencyExponent =
      await this.currencyMetadataService.getExponent(dto.invoiceCurrency);
    const invoiceAmountMinor = BigInt(dto.invoiceAmountMinor);

    let reservedAmountMinor: bigint;
    let fxRate: Decimal;
    let fxRateSource: string;
    let fxRateValidAt: Date;

    if (dto.invoiceCurrency === program.currency) {
      reservedAmountMinor = invoiceAmountMinor;
      fxRate = new Decimal(1);
      fxRateSource = 'IDENTITY';
      fxRateValidAt = new Date();
    } else {
      const resolved = await this.fxService.resolveRate(
        dto.invoiceCurrency,
        program.currency,
      );
      fxRate = resolved.rate;
      fxRateSource = resolved.source;
      fxRateValidAt = resolved.validAt;
      reservedAmountMinor = convertMinorUnits(
        invoiceAmountMinor,
        invoiceCurrencyExponent,
        program.currency_exponent,
        fxRate,
      );
    }

    const updatedProgram = await this.programRepository.reserveCapacity(
      client,
      program.id,
      reservedAmountMinor,
    );

    if (!updatedProgram) {
      return this.handleReservationConflict(
        client,
        program.id,
        reservedAmountMinor,
      );
    }

    const reservation = await this.reservationRepository.insert(client, {
      programId: program.id,
      invoiceId: dto.invoiceId,
      invoiceCurrency: dto.invoiceCurrency,
      invoiceCurrencyExponent,
      invoiceAmountMinor,
      programCurrency: program.currency,
      programCurrencyExponent: program.currency_exponent,
      reservedAmountMinor,
      fxRate: fxRate.toFixed(10),
      fxRateSource,
      fxRateValidAt,
    });

    await this.ledgerRepository.insert(client, {
      programId: program.id,
      reservationId: reservation.id,
      eventType: 'RESERVATION_CREATED',
      amountMinor: reservedAmountMinor,
      currency: program.currency,
      source: 'api',
    });

    const availableAmountMinor = this.computeAvailable(updatedProgram);

    const body: ReservationResponse = {
      reservationId: reservation.id,
      programId: program.id,
      invoiceId: dto.invoiceId,
      status: 'ACTIVE',
      invoiceAmountMinor: bigIntToSafeNumber(invoiceAmountMinor),
      invoiceCurrency: dto.invoiceCurrency,
      reservedAmountMinor: bigIntToSafeNumber(reservedAmountMinor),
      programCurrency: program.currency,
      availableAmountMinor: bigIntToSafeNumber(availableAmountMinor),
      fxRate: fxRate.toFixed(10),
      fxRateValidAt,
    };

    return body;
  }

  private async handleReservationConflict(
    client: PrismaTx,
    programId: string,
    requestedAmountMinor: bigint,
  ): Promise<never> {
    const current = await this.programRepository.findById(client, programId);
    if (!current) {
      throw new AppError(ErrorCode.PROGRAM_NOT_FOUND, 'Program not found.', {
        programId,
      });
    }
    if (current.status !== 'ACTIVE') {
      const code =
        current.status === 'OVER_LIMIT'
          ? ErrorCode.PROGRAM_OVER_LIMIT
          : ErrorCode.PROGRAM_NOT_ACTIVE;
      throw new AppError(code, 'Program not active.', {
        programId,
      });
    }

    const availableAmountMinor = this.computeAvailable(current);
    throw new AppError(
      ErrorCode.INSUFFICIENT_CAPACITY,
      'Program does not have enough available capacity for this reservation.',
      {
        programId,
        availableAmountMinor: bigIntToSafeNumber(availableAmountMinor),
        requestedAmountMinor: bigIntToSafeNumber(requestedAmountMinor),
        currency: current.currency,
      },
    );
  }

  private computeAvailable(program: ProgramRow): bigint {
    const total = BigInt(program.total_limit_minor);
    const reserved = BigInt(program.reserved_amount_minor);
    return reserved > total ? 0n : total - reserved;
  }

  async findById(reservationId: string): Promise<ReservationDetailResponse> {
    const reservation =
      await this.reservationRepository.findById(reservationId);
    if (!reservation) {
      throw new AppError(
        ErrorCode.RESERVATION_NOT_FOUND,
        'Reservation not found.',
        {
          reservationId,
        },
      );
    }
    return {
      reservationId: reservation.id,
      programId: reservation.programId,
      invoiceId: reservation.invoiceId,
      status: reservation.status,
      invoiceAmountMinor: bigIntToSafeNumber(reservation.invoiceAmountMinor),
      invoiceCurrency: reservation.invoiceCurrency,
      reservedAmountMinor: bigIntToSafeNumber(reservation.reservedAmountMinor),
      programCurrency: reservation.programCurrency,
      fxRate: reservation.fxRate.toString(),
      fxRateSource: reservation.fxRateSource,
      fxRateValidAt: reservation.fxRateValidAt,
      releasedAt: reservation.releasedAt,
      reconciledAt: reservation.reconciledAt,
    };
  }

  async release(reservationId: string): Promise<ReleaseReservationResponse> {
    return await this.transactionManager.run((client) =>
      this.runReleaseTransaction(client, reservationId),
    );
  }

  private async runReleaseTransaction(
    client: PrismaTx,
    reservationId: string,
  ): Promise<ReleaseReservationResponse> {
    const reservation = await this.reservationRepository.findByIdForUpdate(
      client,
      reservationId,
    );
    if (!reservation) {
      throw new AppError(
        ErrorCode.RESERVATION_NOT_FOUND,
        'Reservation not found.',
        { reservationId },
      );
    }

    if (reservation.status === 'RELEASED') {
      const availableAmountMinor = await this.availableForProgram(
        client,
        reservation.program_id,
      );
      const body = this.buildReleaseResponse(reservation, availableAmountMinor);
      return body;
    }

    if (reservation.status === 'RECONCILED') {
      throw new AppError(
        ErrorCode.RECONCILIATION_CONFLICT,
        'Reservation was superseded by treasury reconciliation and cannot be released through the API.',
        { reservationId, status: reservation.status },
      );
    }

    // Lock the program row before mutating its aggregate capacity, per the
    // reserve/release invariant: reservation lock first, then program lock.
    await this.programRepository.findByIdForUpdate(
      client,
      reservation.program_id,
    );

    const reservedAmountMinor = BigInt(reservation.reserved_amount_minor);
    const updatedProgram = await this.programRepository.releaseCapacity(
      client,
      reservation.program_id,
      reservedAmountMinor,
    );
    const updatedReservation = await this.reservationRepository.markReleased(
      client,
      reservationId,
    );

    await this.ledgerRepository.insert(client, {
      programId: reservation.program_id,
      reservationId,
      eventType: 'RESERVATION_RELEASED',
      amountMinor: -reservedAmountMinor,
      currency: reservation.program_currency,
      source: 'api',
    });

    const availableAmountMinor = this.computeAvailable(updatedProgram);
    const body = this.buildReleaseResponse(
      updatedReservation,
      availableAmountMinor,
    );
    return body;
  }

  private async availableForProgram(
    client: PrismaTx,
    programId: string,
  ): Promise<bigint> {
    const program = await this.programRepository.findById(client, programId);
    return program ? this.computeAvailable(program) : 0n;
  }

  private buildReleaseResponse(
    reservation: ReservationRow,
    availableAmountMinor: bigint,
  ): ReleaseReservationResponse {
    return {
      reservationId: reservation.id,
      programId: reservation.program_id,
      status: reservation.status,
      releasedAmountMinor: bigIntToSafeNumber(
        BigInt(reservation.reserved_amount_minor),
      ),
      programCurrency: reservation.program_currency,
      availableAmountMinor: bigIntToSafeNumber(availableAmountMinor),
      releasedAt: reservation.released_at,
    };
  }
}
