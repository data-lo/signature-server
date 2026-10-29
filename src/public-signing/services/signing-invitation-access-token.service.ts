import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { SigningAccessChannel } from 'src/document/interfaces/signing-actor.interface';

import { PUBLIC_SIGNING_INVITATION_ACCESS_TTL_SECONDS } from '../public-signing-session.cookie';

/** Propósito de la llave derivada; ningún otro token se firma con ella. */
const PURPOSE = 'SIGNING_INVITATION_ACCESS';

/** Lo que acredita la cookie de acceso a una invitación (antes del código). */
export interface SigningInvitationAccessClaims {
  invitationId: string;
  channel: SigningAccessChannel;
}

/**
 * Emite y verifica el token de la cookie de acceso a una invitación: el paso entre canjear el token
 * de la URL (correo o portal del tercero) y validar el código del correo.
 *
 * Igual que los demás tokens públicos, se firma con una llave DERIVADA de `JWT_SECRET` y propia de
 * este propósito: no lo acepta el guard de la plataforma, ni el de la sesión de firma, ni al revés.
 * Sólo lleva el id de la invitación y el canal; si la invitación sigue sirviendo lo decide la base.
 */
@Injectable()
export class SigningInvitationAccessTokenService {
  private readonly jwt: JwtService;

  constructor(configService: ConfigService) {
    const baseSecret = configService.get<string>('JWT_SECRET') ?? '';
    this.jwt = new JwtService({
      secret: createHash('sha256')
        .update(`${baseSecret}:${PURPOSE}`)
        .digest('hex'),
    });
  }

  /**
   * Firma el token de acceso a una invitación.
   *
   * @param claims - Invitación y canal.
   * @returns El token y cuándo vence.
   *
   * @throws Nada.
   *
   * @example
   * ```ts
   * const { token } = tokens.issue({ invitationId: 'inv-1', channel: 'EMAIL' });
   * ```
   */
  issue(claims: SigningInvitationAccessClaims): {
    token: string;
    expiresAt: Date;
  } {
    const token = this.jwt.sign(
      { purpose: PURPOSE, ...claims },
      { expiresIn: PUBLIC_SIGNING_INVITATION_ACCESS_TTL_SECONDS },
    );
    return {
      token,
      expiresAt: new Date(
        Date.now() + PUBLIC_SIGNING_INVITATION_ACCESS_TTL_SECONDS * 1000,
      ),
    };
  }

  /**
   * Verifica firma, vencimiento y propósito.
   *
   * @param token - Valor de la cookie.
   * @returns Invitación y canal, o `null` si el token no sirve.
   *
   * @throws Nada.
   *
   * @example
   * ```ts
   * const claims = tokens.verify(cookieValue);
   * ```
   */
  verify(token: string): SigningInvitationAccessClaims | null {
    try {
      const payload = this.jwt.verify<{
        purpose?: string;
        invitationId?: string;
        channel?: string;
      }>(token);
      if (
        payload.purpose !== PURPOSE ||
        !payload.invitationId ||
        (payload.channel !== 'EMAIL' &&
          payload.channel !== 'THIRD_PARTY_PORTAL')
      ) {
        return null;
      }
      return { invitationId: payload.invitationId, channel: payload.channel };
    } catch {
      return null;
    }
  }
}
