import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { SigningInvitationAccessContext } from '../interfaces/signing-invitation-access-context.interface';
import {
  PUBLIC_SIGNING_INVITATION_COOKIE,
  readCookie,
} from '../public-signing-session.cookie';
import { PublicSigningInvitationResolver } from '../services/public-signing-invitation-resolver.service';
import { SigningInvitationAccessTokenService } from '../services/signing-invitation-access-token.service';

/** 401 único: falta la cookie, no se puede verificar, venció o su invitación ya no existe. */
export class InvalidSigningInvitationAccessException extends UnauthorizedException {
  constructor() {
    super(
      'Tu acceso a esta invitación venció. Vuelve a abrir el enlace de tu invitación.',
    );
  }
}

/**
 * Autentica los pasos previos a la sesión (`/public/signing-invitations/current/...`) con la cookie
 * de acceso que deja el canje del token del correo o del portal del tercero. Es el ÚNICO mecanismo
 * de esas rutas: no mira JWT, `X-API-Key`, ni la cookie de la sesión de firma.
 *
 * No exige que la invitación esté activa —el contexto también informa un estado como
 * `WAITING_FOR_PREVIOUS_SIGNER`—; eso lo exigen el envío y la validación del código.
 */
@Injectable()
export class SigningInvitationAccessGuard implements CanActivate {
  constructor(
    private readonly tokens: SigningInvitationAccessTokenService,
    private readonly resolver: PublicSigningInvitationResolver,
  ) {}

  /**
   * Resuelve la invitación de la cookie.
   *
   * @param context - Contexto de ejecución de Nest.
   * @returns `true` si la cookie sirve y su invitación existe.
   *
   * @throws {InvalidSigningInvitationAccessException} (401) Mensaje genérico.
   *
   * @example
   * ```ts
   * @UseGuards(SigningInvitationAccessGuard)
   * ```
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<
        Request & { signingInvitationAccess?: SigningInvitationAccessContext }
      >();

    const token = readCookie(
      request.headers?.cookie,
      PUBLIC_SIGNING_INVITATION_COOKIE,
    );
    const claims = token ? this.tokens.verify(token) : null;
    if (!claims) throw new InvalidSigningInvitationAccessException();

    try {
      request.signingInvitationAccess = {
        resolved: await this.resolver.resolveById(claims.invitationId),
        channel: claims.channel,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new InvalidSigningInvitationAccessException();
      }
      throw error;
    }
    return true;
  }
}
