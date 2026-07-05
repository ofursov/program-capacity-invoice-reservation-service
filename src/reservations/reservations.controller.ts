import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Scopes } from '../auth/scopes.decorator';
import { ReservationsService } from './reservations.service';
import { CreateReservationRequest } from './dto/create-reservation.request';
import { ReservationResponse } from './dto/reservation.response';
import { ReservationDetailResponse } from './dto/reservation-detail.response';
import { ReleaseReservationResponse } from './dto/release-reservation.response';

@ApiTags('Reservations')
@ApiBearerAuth('JWT-auth')
@Controller('v1/reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  @Scopes('capacity:write')
  @ApiOkResponse({ type: ReservationResponse })
  async create(
    @Body() dto: CreateReservationRequest,
  ): Promise<ReservationResponse> {
    return await this.reservationsService.create(dto);
  }

  @Post(':reservationId/release')
  @Scopes('capacity:write')
  @ApiOkResponse({ type: ReleaseReservationResponse })
  async release(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): Promise<ReleaseReservationResponse> {
    return await this.reservationsService.release(reservationId);
  }

  @Get(':reservationId')
  @Scopes('capacity:read')
  @ApiOkResponse({ type: ReservationDetailResponse })
  async getById(
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ): Promise<ReservationDetailResponse> {
    return await this.reservationsService.findById(reservationId);
  }
}
