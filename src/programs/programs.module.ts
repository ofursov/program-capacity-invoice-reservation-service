import { Module } from '@nestjs/common';
import { ProgramsController } from './programs.controller';
import { ProgramsService } from './programs.service';
import { ProgramRepository } from './program.repository';

@Module({
  controllers: [ProgramsController],
  providers: [ProgramsService, ProgramRepository],
  exports: [ProgramRepository],
})
export class ProgramsModule {}
