import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { envSchema } from './env.schema';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      validationSchema: envSchema,
      validationOptions: {
        abortEarly: false,
      },
    }),
  ],
})
export class ConfigModule {}
