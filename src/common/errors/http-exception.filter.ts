import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from './app-error';
import { ERROR_CODE_HTTP_STATUS, ErrorCode } from './error-codes';

interface ErrorResponseBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as Request & { id?: string }).id;

    const { status, body } = this.resolve(exception, requestId);

    if (status >= 500) {
      const err =
        exception instanceof Error ? exception : new Error(String(exception));
      // `@nestjs/common`'s Logger (routed through nestjs-pino once
      // `app.useLogger` is set) treats a second argument as the Nest
      // "context" string, not a pino message — so the message goes inside
      // the merged object as `msg` to land as the log line's message.
      this.logger.error({ err, requestId, msg: 'Unhandled exception' });
    }

    response.status(status).json(body);
  }

  private resolve(
    exception: unknown,
    requestId?: string,
  ): { status: number; body: ErrorResponseBody } {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus,
        body: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          requestId,
        },
      };
    }

    if (
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === 'P2002'
    ) {
      const target = Array.isArray(exception.meta?.target)
        ? (exception.meta.target as string[])
        : [];
      if (target.includes('invoiceId') || target.includes('invoice_id')) {
        return this.fromCode(ErrorCode.INVOICE_ALREADY_RESERVED, requestId);
      }
      if (
        target.includes('externalMessageId') ||
        target.includes('external_message_id')
      ) {
        return this.fromCode(
          ErrorCode.TREASURY_MESSAGE_ALREADY_PROCESSED,
          requestId,
        );
      }
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const code = this.httpStatusToErrorCode(status);
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ??
            exception.message);

      return {
        status,
        body: {
          code,
          message: Array.isArray(message) ? message.join('; ') : message,
          details:
            typeof payload === 'object'
              ? (payload as Record<string, unknown>)
              : undefined,
          requestId,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred.',
        requestId,
      },
    };
  }

  private fromCode(
    code: ErrorCode,
    requestId?: string,
  ): { status: number; body: ErrorResponseBody } {
    return {
      status: ERROR_CODE_HTTP_STATUS[code],
      body: { code, message: 'Conflict.', requestId },
    };
  }

  private httpStatusToErrorCode(status: HttpStatus): ErrorCode {
    if (status === HttpStatus.UNAUTHORIZED) {
      return ErrorCode.UNAUTHORIZED;
    }
    if (status === HttpStatus.FORBIDDEN) {
      return ErrorCode.FORBIDDEN;
    }
    if (status === HttpStatus.BAD_REQUEST) {
      return ErrorCode.VALIDATION_ERROR;
    }
    if (status === HttpStatus.NOT_FOUND) {
      return ErrorCode.RESERVATION_NOT_FOUND;
    }
    return ErrorCode.INTERNAL_ERROR;
  }
}
