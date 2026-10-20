import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { GuestSigningAccessEntity } from 'src/document/entities/guest-signing-access.entity';
import { InvalidGuestSigningAccessException } from 'src/document/exceptions/guest-signing-access.exceptions';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from 'src/document/enum/guest-signing-access-purpose.enum';

/** Lo que acredita un token de invitado. Por sí solo no basta: el acceso tiene que seguir activo. */
export interface GuestSigningTokenClaims {
  /** `jti`: id de la fila de `guest_signing_accesses`. */
  accessId: string;
  documentId: string;
  collaboratorId: string;
  purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM;
}

/**
 * Emite y verifica el token con el que un invitado sin cuenta opera su Firma Avanzada.
 *
 * Igual que el token biométrico, se firma con una llave DERIVADA de `JWT_SECRET` y propia de este
 * propósito: ni el guard de sesión lo acepta como token de usuario, ni el guard biométrico como
 * suyo, ni éste a ninguno de los dos.
 *
 * El token sólo lleva identificadores (acceso, documento, colaborador, propósito) y su
 * vencimiento: nada de correo ni de datos del documento. Que el acceso siga activo lo decide
 * `guest_signing_accesses`, no el token.
 */
@Injectable()
export class GuestSigningTokenService {
  private readonly jwt: JwtService;

  constructor(configService: ConfigService) {
    const baseSecret = configService.get<string>('JWT_SECRET') ?? '';
    this.jwt = new JwtService({
      secret: createHash('sha256')
        .update(
          `${baseSecret}:${GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS}`,
        )
        .digest('hex'),
    });
  }

  /**
   * Firma el token de un acceso recién emitido; vence junto con él.
   *
   * @param access - Acceso de `guest_signing_accesses`.
   * @returns El token y cuándo vence.
   *
   * @example
   * ```ts
   * const { accessToken, expiresAt } = tokens.issue(access);
   * ```
   */
  issue(access: GuestSigningAccessEntity): {
    accessToken: string;
    expiresAt: Date;
  } {
    const expiresInSeconds = Math.max(
      1,
      Math.floor((access.expiresAt.getTime() - Date.now()) / 1000),
    );

    const accessToken = this.jwt.sign(
      {
        purpose: access.purpose,
        documentId: access.documentId,
        collaboratorId: access.collaboratorId,
      },
      { jwtid: access.id, expiresIn: expiresInSeconds },
    );

    return { accessToken, expiresAt: access.expiresAt };
  }

  /**
   * Verifica firma, vencimiento y propósito del token, y que sea del documento de la ruta.
   *
   * @param token - Valor de la cabecera `X-Guest-Signing-Token`.
   * @param documentId - Documento de la ruta.
   * @returns Lo que acredita el token.
   *
   * @throws {InvalidGuestSigningAccessException} Si falta, venció, está alterado, es de otro
   *   propósito o de otro documento.
   *
   * @example
   * ```ts
   * const claims = tokens.verify(header, 'd-1');
   * ```
   */
  verify(
    token: string | undefined,
    documentId: string,
  ): GuestSigningTokenClaims {
    if (!token) {
      throw new InvalidGuestSigningAccessException();
    }

    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify<Record<string, unknown>>(token);
    } catch {
      throw new InvalidGuestSigningAccessException();
    }

    const valid =
      payload.purpose ===
        GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS &&
      payload.documentId === documentId &&
      typeof payload.collaboratorId === 'string' &&
      typeof payload.jti === 'string';

    if (!valid) {
      throw new InvalidGuestSigningAccessException();
    }

    return {
      accessId: payload.jti as string,
      documentId,
      collaboratorId: payload.collaboratorId as string,
      purpose:
        GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
    };
  }
}
