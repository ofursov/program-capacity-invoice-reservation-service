import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive, IsString, IsUUID, Length } from 'class-validator';

export class CreateReservationRequest {
  @ApiProperty()
  @IsUUID()
  programId!: string;

  @ApiProperty({ example: 'inv-0001' })
  @IsString()
  invoiceId!: string;

  @ApiProperty({ example: 100000 })
  @IsInt()
  @IsPositive()
  invoiceAmountMinor!: number;

  @ApiProperty({ example: 'EUR', minLength: 3, maxLength: 3 })
  @IsString()
  @Length(3, 3)
  invoiceCurrency!: string;
}
