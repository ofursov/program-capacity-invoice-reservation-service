import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';
import { EnvConfig } from '../config/env.schema';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AuthenticatedUser } from './authenticated-user.interface';

interface JwtPayload {
  sub: string;
  scope?: string;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<EnvConfig, true>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Missing bearer token.');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.configService.get('JWT_SECRET', { infer: true }),
      });
    } catch {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid or expired token.');
    }

    const user: AuthenticatedUser = {
      sub: payload.sub,
      scopes: (payload.scope ?? '').split(' ').filter(Boolean),
    };
    (request as Request & { user?: AuthenticatedUser }).user = user;

    return true;
  }

  private extractBearerToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) {
      return undefined;
    }
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return undefined;
    }
    return token;
  }
}
