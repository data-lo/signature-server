import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from 'src/document/enum/guest-signing-access-purpose.enum';
import { GuestSigningAccessService } from 'src/document/services/guest-signing-access.service';
import { SigningInvitationService } from 'src/signing-invitation/signing-invitation.service';

import { PublicSigningSessionContext } from '../interfaces/public-signing-session-context.interface';
import { isPublicSigningAllowed } from 'src/signing-invitation/public-signing-eligibility';
import {
  PUBLIC_SIGNING_SESSION_COOKIE,
  readCookie,
} from '../public-signing-session.cookie';
import { PublicSigningSessionTokenService } from '../services/public-signing-session-token.service';

/** 401 único para cualquier sesión que no sirve: no dice si faltó, venció o se revocó. */
export class InvalidPublicSigningSessionException extends UnauthorizedException {
  constructor() {
    super(
      'Tu sesión de firma no es válida o venció. Vuelve a abrir tu invitación y valida el código.',
    );
  }
}

/**
 * Autentica los endpoints de la sesión pública de firma (`/public/signing-sessions/current/...`)
 * con la cookie `HttpOnly` que dejó la validación del código. Es el ÚNICO mecanismo de esas
 * rutas: no mira JWT de la plataforma, ni `X-API-Key`, ni el token de la invitación.
 *
 * Comprueba, en orden:
 * 1. Firma, vencimiento y propósito del token de la cookie.
 * 2. Que su acceso (`guest_signing_accesses`) siga activo y sea de esa invitación.
 * 3. Que la invitación no se haya revocado (vencer el enlace no corta una sesión ya abierta).
 * 4. Que el firmante siga pudiendo firmar desde la invitación pública.
 *
 * Deja en `request.signingSession` el `PublicSigningSessionContext`, con el actor
 * `PUBLIC_INVITATION`.
 */
@Injectable()
export class PublicSigningSessionGuard implements CanActivate {
  constructor(
    private readonly tokens: PublicSigningSessionTokenService,
    private readonly accesses: GuestSigningAccessService,
    private readonly invitations: SigningInvitationService,
  ) {}

  /**
   * Resuelve la sesión de la cookie.
   *
   * @param context - Contexto de ejecución de Nest.
   * @returns `true` si la sesión sirve.
   *
   * @throws {InvalidPublicSigningSessionException} (401) Si falta, no se puede verificar, venció,
   *   se consumió o se revocó, o el firmante ya no puede firmar por aquí.
   *
   * @example
   * ```ts
   * @UseGuards(PublicSigningSessionGuard)
   * ```
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { signingSession?: PublicSigningSessionContext }>();

    const token = readCookie(
      request.headers?.cookie,
      PUBLIC_SIGNING_SESSION_COOKIE,
    );
    const claims = token ? this.tokens.verify(token) : null;
    if (!claims) throw new InvalidPublicSigningSessionException();

    const access = await this.accesses.findActive(claims.accessId);
    if (
      !access ||
      access.purpose !==
        GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION ||
      access.documentId !== claims.documentId ||
      access.collaboratorId !== claims.collaboratorId
    ) {
      throw new InvalidPublicSigningSessionException();
    }

    const invitation = await this.invitations.findById(claims.invitationId);
    const document = invitation?.document;
    const collaborator = invitation?.collaborator;
    if (
      !invitation ||
      invitation.revokedAt ||
      !document ||
      !collaborator ||
      invitation.collaboratorId !== access.collaboratorId ||
      invitation.documentId !== access.documentId ||
      !isPublicSigningAllowed(collaborator)
    ) {
      throw new InvalidPublicSigningSessionException();
    }

    request.signingSession = {
      actor: {
        type: 'PUBLIC_INVITATION',
        invitationId: invitation.id,
        collaboratorId: collaborator.id,
        ...(collaborator.account?.userId
          ? { userId: collaborator.account.userId }
          : {}),
        ...(collaborator.accountId
          ? { accountId: collaborator.accountId }
          : {}),
        organizationId: document.organizationId ?? null,
        sessionAccessId: access.id,
        verifiedEmail: true,
      },
      document,
      collaborator,
      expiresAt: access.expiresAt,
    };
    return true;
  }
}
