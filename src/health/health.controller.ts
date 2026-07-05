import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../database/prisma.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new HttpException(
        {
          message: 'Dependency check failed.',
          dependencies: { postgres: 'down' },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: 'ok', dependencies: { postgres: 'up' } };
  }
}
