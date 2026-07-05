import * as Joi from 'joi';

export const envSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),

  DATABASE_URL: Joi.string().uri().required(),

  JWT_SECRET: Joi.string().min(16).required(),

  KAFKA_BROKERS: Joi.string().required(),
  KAFKA_CLIENT_ID: Joi.string().default('capacity-service'),
  KAFKA_CONSUMER_GROUP_ID: Joi.string().default(
    'capacity-service-treasury-consumer',
  ),

  SWAGGER_ENABLED: Joi.boolean().default(false),

  SERVICE_NAME: Joi.string().default('finverity-reservation-program'),
  LOG_LEVEL: Joi.string().valid(
    'fatal',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'silent',
  ),
  LOG_PRETTY: Joi.boolean(),
  APP_VERSION: Joi.string().default('local'),
}).unknown(true);

export interface EnvConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  KAFKA_BROKERS: string;
  KAFKA_CLIENT_ID: string;
  KAFKA_CONSUMER_GROUP_ID: string;
  SWAGGER_ENABLED: boolean;
  SERVICE_NAME: string;
  LOG_LEVEL?:
    'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  LOG_PRETTY?: boolean;
  APP_VERSION: string;
}
