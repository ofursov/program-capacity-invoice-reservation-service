import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/errors/http-exception.filter';
import { EnvConfig } from './config/env.schema';
import { attachRequestId } from './logger/logger.utils';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Registered directly on the underlying HTTP stack (ahead of any
  // Nest-managed middleware, including pino-http) so the request id is
  // already pinned by the time pino-http's genReqId runs.
  app.use(attachRequestId);
  app.useLogger(app.get(Logger));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const configService = app.get(ConfigService<EnvConfig, true>);
  const port = configService.get('PORT', { infer: true });

  if (configService.get('SWAGGER_ENABLED', { infer: true })) {
    const config = new DocumentBuilder()
      .setTitle('Program Capacity & Invoice Reservation API')
      .setDescription(
        'Tracks financing program capacity, invoice reservations, and treasury reconciliation. ',
      )
      .setVersion('1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'JWT-auth',
      )
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(port);
}
void bootstrap();
