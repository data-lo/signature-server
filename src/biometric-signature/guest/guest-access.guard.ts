import {
  CanActivate,
  ExecutionContext,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  GuestAccessClaims,
  GuestAccessTokenService,
} from './guest-access-token.service';

/** Cabecera del token de invitado. Propia, para no chocar con el `Authorization` de sesión. */
export const GUEST_ACCESS_TOKEN_HEADER = 'x-biometric-guest-token';

type GuestRequest = Request & { guestAccess?: GuestAccessClaims };

/**
 * Exige un token de invitado válido para el `:documentId` de la ruta y lo deja en la petición.
 *
 * Las rutas públicas que lo usan llevan además `@SkipJwtAuth()`: un invitado no tiene sesión, y
 * lo que lo autentica es haber validado el OTP de su invitación.
 */
@Injectable()
export class GuestAccessGuard implements CanActivate {
  constructor(private readonly tokens: GuestAccessTokenService) {}

  /**
   * Verifica el token de la cabecera contra el documento de la ruta.
   *
   * @param context - Contexto de la petición.
   * @returns `true` si el token es válido.
   *
   * @throws {InvalidGuestAccessTokenException} Si el token falta, venció o es de otro documento.
   *
   * @example
   * ```ts
   * @UseGuards(GuestAccessGuard)
   * ```
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<GuestRequest>();
    const header = request.headers[GUEST_ACCESS_TOKEN_HEADER];
    const token = Array.isArray(header) ? header[0] : header;

    request.guestAccess = this.tokens.verify(
      token,
      String(request.params.documentId),
    );
    return true;
  }
}

/** Lo que acreditó `GuestAccessGuard` para esta petición. */
export const CurrentGuestAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): GuestAccessClaims =>
    context.switchToHttp().getRequest<GuestRequest>().guestAccess,
);
