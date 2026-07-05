import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Scopes } from '../auth/scopes.decorator';
import { ProgramsService } from './programs.service';
import { ProgramAvailabilityResponse } from './dto/program-availability.response';

@ApiTags('Programs')
@ApiBearerAuth('JWT-auth')
@Controller('v1/programs')
export class ProgramsController {
  constructor(private readonly programsService: ProgramsService) {}

  @Get(':programId/availability')
  @Scopes('capacity:read')
  @ApiOkResponse({ type: ProgramAvailabilityResponse })
  getAvailability(
    @Param('programId', ParseUUIDPipe) programId: string,
  ): Promise<ProgramAvailabilityResponse> {
    return this.programsService.getAvailability(programId);
  }
}
