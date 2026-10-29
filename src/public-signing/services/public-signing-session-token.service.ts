import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { GuestSigningAccessEntity } from 'src/document/entities/guest-signing-access.entity';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from 'src/document/enum/guest-signing-access-purpose.enum';
import { SigningAccessChannel } from 'src/document/interfaces/signing-actor.interface';

/** Lo que acredita el token de una sesión pública. El acceso tiene que seguir activo. */
export interface PublicSigningSessionClaims {
  /** `jti`: id de la fila de `guest_signing_accesses`. */
  accessId: string;
  invitationId: string;
  documentId: string;
  collaboratorId: string;
  /** Por dónde llegó el firmante a su invitación. */
  channel: SigningAccessChannel;
}

/**
 * Emite y verifica el token de la sesión pública de firma, el que viaja en la cookie `HttpOnly`.
 *
 * Igual que los tokens de invitado que ya existen, se firma con una llave DERIVADA de `JWT_SECRET`
 * y propia de este propósito: ni el guard de sesión de la plataforma lo acepta como token de
 * usuario, ni los guards de invitado como suyo, ni éste a ninguno de ellos. Sólo lleva
 * identificadores; si sirve o no lo decide `guest_signing_accesses`.
 */
@Injectable()
export class PublicSigningSessionTokenService {
  private readonly jwt: JwtService;

  constructor(configService: ConfigService) {
    const baseSecret = configService.get<string>('JWT_SECRET') ?? '';
    this.jwt = new JwtService({
      secret: createHash('sha256')
        .update(
          `${baseSecret}:${GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION}`,
        )
        .digest('hex'),
    });
  }

  /**
   * Firma el token de un acceso recién emitido; vence junto con él.
   *
   * @param access - Acceso `PUBLIC_SIGNING_SESSION`.
   * @param invitationId - Invitación que abrió la sesión.
   * @param channel - Por dónde llegó el firmante (correo o portal del tercero).
   * @returns El token y cuándo vence.
   *
   * @throws Nada.
   *
   * @example
   * ```ts
   * const { token, expiresAt } = tokens.issue(access, 'inv-1', 'EMAIL');
   * ```
   */
  issue(
    access: GuestSigningAccessEntity,
    invitationId: string,
    channel: SigningAccessChannel,
  ): { token: string; expiresAt: Date } {
    const expiresInSeconds = Math.max(
      1,
      Math.floor((access.expiresAt.getTime() - Date.now()) / 1000),
    );

    const token = this.jwt.sign(
      {
        purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION,
        invitationId,
        documentId: access.documentId,
        collaboratorId: access.collaboratorId,
        channel,
      },
      { jwtid: access.id, expiresIn: expiresInSeconds },
    );

    return { token, expiresAt: access.expiresAt };
  }

  /**
   * Verifica firma, vencimiento y propósito del token.
   *
   * @param token - Valor de la cookie.
   * @returns Los identificadores de la sesión, o `null` si el token no sirve.
   *
   * @throws Nada: cualquier fallo es `null`.
   *
   * @example
   * ```ts
   * const claims = tokens.verify(cookieValue);
   * ```
   */
  verify(token: string): PublicSigningSessionClaims | null {
    try {
      const payload = this.jwt.verify<{
        jti?: string;
        purpose?: string;
        invitationId?: string;
        documentId?: string;
        collaboratorId?: string;
        channel?: string;
      }>(token);
      if (
        payload.purpose !==
          GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION ||
        !payload.jti ||
        !payload.invitationId ||
        !payload.documentId ||
        !payload.collaboratorId
      ) {
        return null;
      }
      return {
        accessId: payload.jti,
        invitationId: payload.invitationId,
        documentId: payload.documentId,
        collaboratorId: payload.collaboratorId,
        channel:
          payload.channel === 'THIRD_PARTY_PORTAL'
            ? 'THIRD_PARTY_PORTAL'
            : 'EMAIL',
      };
    } catch {
      return null;
    }
  }
}
