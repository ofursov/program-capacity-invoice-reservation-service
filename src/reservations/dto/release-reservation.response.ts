import { ApiProperty } from '@nestjs/swagger';

export class ReleaseReservationResponse {
  @ApiProperty() reservationId!: string;
  @ApiProperty() programId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() releasedAmountMinor!: number;
  @ApiProperty() programCurrency!: string;
  @ApiProperty() availableAmountMinor!: number;
  @ApiProperty({ required: false, nullable: true }) releasedAt!: Date | null;
}
