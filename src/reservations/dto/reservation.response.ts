import { ApiProperty } from '@nestjs/swagger';

export class ReservationResponse {
  @ApiProperty() reservationId!: string;
  @ApiProperty() programId!: string;
  @ApiProperty() invoiceId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() invoiceAmountMinor!: number;
  @ApiProperty() invoiceCurrency!: string;
  @ApiProperty() reservedAmountMinor!: number;
  @ApiProperty() programCurrency!: string;
  @ApiProperty() availableAmountMinor!: number;
  @ApiProperty() fxRate!: string;
  @ApiProperty() fxRateValidAt!: Date;
}
