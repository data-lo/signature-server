import {
  CanActivate,
  ExecutionContext,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';

import { GuestSigningAccessService } from 'src/document/services/guest-signing-access.service';
import { InvalidGuestSigningAccessException } from 'src/document/exceptions/guest-signing-access.exceptions';

import {
  GuestSigningTokenClaims,
  GuestSigningTokenService,
} from './guest-signing-token.service';

/** Cabecera del token de invitado de Firma Avanzada. Propia, para no chocar con `Authorization`. */
export const GUEST_SIGNING_TOKEN_HEADER = 'x-guest-signing-token';

type GuestSigningRequest = Request & {
  guestSigningAccess?: GuestSigningTokenClaims;
};

/**
 * Exige un token de invitado válido para el `:documentId` de la ruta y un acceso ACTIVO detrás.
 *
 * Dos comprobaciones, las dos necesarias:
 * 1. El token: firma, vencimiento, propósito y documento (`GuestSigningTokenService`).
 * 2. La fila de `guest_signing_accesses` de su `jti`: que no haya vencido, ni se haya consumido, ni
 *    se haya revocado, y que sea del mismo documento y colaborador. Esto es lo que permite que un
 *    token ya entregado deje de servir al vincular una cuenta o al firmar.
 *
 * Las rutas que lo usan llevan además `@SkipJwtAuth()`: el invitado no tiene sesión.
 */
@Injectable()
export class GuestSigningAccessGuard implements CanActivate {
  constructor(
    private readonly tokens: GuestSigningTokenService,
    private readonly accesses: GuestSigningAccessService,
  ) {}

  /**
   * Verifica el token de la cabecera y el acceso que identifica.
   *
   * @param context - Contexto de la petición.
   * @returns `true` si el token es válido y su acceso está activo.
   *
   * @throws {InvalidGuestSigningAccessException} Si el token falta o no es válido, o su acceso ya
   *   no está activo o no corresponde.
   *
   * @example
   * ```ts
   * @UseGuards(GuestSigningAccessGuard)
   * ```
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuestSigningRequest>();
    const header = request.headers[GUEST_SIGNING_TOKEN_HEADER];
    const token = Array.isArray(header) ? header[0] : header;

    const claims = this.tokens.verify(token, String(request.params.documentId));

    const access = await this.accesses.findActive(claims.accessId);
    if (
      !access ||
      access.documentId !== claims.documentId ||
      access.collaboratorId !== claims.collaboratorId ||
      access.purpose !== claims.purpose
    ) {
      throw new InvalidGuestSigningAccessException();
    }

    request.guestSigningAccess = claims;
    return true;
  }
}

/** Lo que acreditó `GuestSigningAccessGuard` para esta petición. */
export const CurrentGuestSigningAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): GuestSigningTokenClaims =>
    context.switchToHttp().getRequest<GuestSigningRequest>()
      .guestSigningAccess!,
);
