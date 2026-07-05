import { ApiProperty } from '@nestjs/swagger';

export class ReservationDetailResponse {
  @ApiProperty() reservationId!: string;
  @ApiProperty() programId!: string;
  @ApiProperty() invoiceId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() invoiceAmountMinor!: number;
  @ApiProperty() invoiceCurrency!: string;
  @ApiProperty() reservedAmountMinor!: number;
  @ApiProperty() programCurrency!: string;
  @ApiProperty() fxRate!: string;
  @ApiProperty() fxRateSource!: string;
  @ApiProperty() fxRateValidAt!: Date;
  @ApiProperty({ required: false, nullable: true }) releasedAt!: Date | null;
  @ApiProperty({ required: false, nullable: true }) reconciledAt!: Date | null;
}
