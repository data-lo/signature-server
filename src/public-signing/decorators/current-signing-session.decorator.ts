import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';

import { PublicSigningSessionContext } from '../interfaces/public-signing-session-context.interface';

/**
 * Contexto de la sesión pública de firma que dejó `PublicSigningSessionGuard`.
 *
 * @returns El `PublicSigningSessionContext` del request.
 *
 * @throws {InternalServerErrorException} Si se usa en una ruta sin el guard: es un error de
 *   programación, no del cliente.
 *
 * @example
 * ```ts
 * current(@CurrentSigningSession() session: PublicSigningSessionContext) {}
 * ```
 */
export const CurrentSigningSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PublicSigningSessionContext => {
    const session = context.switchToHttp().getRequest<{
      signingSession?: PublicSigningSessionContext;
    }>().signingSession;
    if (!session) {
      throw new InternalServerErrorException(
        'La ruta no tiene PublicSigningSessionGuard',
      );
    }
    return session;
  },
);
