import { ERROR_CODE_HTTP_STATUS, ErrorCode } from './error-codes';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.httpStatus = ERROR_CODE_HTTP_STATUS[code];
    this.details = details;
  }
}
