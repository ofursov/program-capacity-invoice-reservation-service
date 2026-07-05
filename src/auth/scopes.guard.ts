import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { AuthenticatedUser } from './authenticated-user.interface';
import { SCOPES_KEY } from './scopes.decorator';

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(
      SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredScopes || requiredScopes.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as Request & { user?: AuthenticatedUser }).user;
    const userScopes = user?.scopes ?? [];

    const hasAllScopes = requiredScopes.every((scope) =>
      userScopes.includes(scope),
    );
    if (!hasAllScopes) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Insufficient scope for this operation.',
        { requiredScopes },
      );
    }

    return true;
  }
}
