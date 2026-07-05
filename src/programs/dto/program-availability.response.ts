import { ApiProperty } from '@nestjs/swagger';

export class ProgramAvailabilityResponse {
  @ApiProperty() programId!: string;
  @ApiProperty() externalRef!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() totalLimitMinor!: number;
  @ApiProperty() reservedAmountMinor!: number;
  @ApiProperty() availableAmountMinor!: number;
  @ApiProperty() overReservedAmountMinor!: number;
  @ApiProperty() status!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ required: false, nullable: true })
  lastReconciledAt!: Date | null;
}
