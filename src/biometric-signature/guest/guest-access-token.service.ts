import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InvalidGuestAccessTokenException } from '../biometric-signature.exceptions';

/** Vigencia del acceso de invitado: alcanza para revisar el documento y completar Didit. */
export const GUEST_ACCESS_TOKEN_TTL_SECONDS = 30 * 60;

/** Marca que distingue estos tokens de cualquier otro firmado por el servidor. */
const GUEST_ACCESS_PURPOSE = 'biometric-signature-guest-access';

/** Lo que acredita un token de invitado: que validó el OTP de ESTA invitación. */
export interface GuestAccessClaims {
  documentId: string;
  collaboratorId: string;
  /** Correo de la invitación, normalizado en minúsculas. */
  email: string;
}

/**
 * Emite y verifica el token con el que un invitado sin cuenta opera su firma biométrica, una vez
 * que validó el código enviado a su correo.
 *
 * **No usa `JWT_SECRET` tal cual**: se firma con una llave DERIVADA de él. Firmado con la misma
 * llave que las sesiones, el guard global de JWT lo aceptaría como token de usuario. Con la
 * derivada, ninguno de los dos tipos de token sirve en lugar del otro, y no hace falta otra
 * variable de entorno.
 */
@Injectable()
export class GuestAccessTokenService {
  private readonly jwt: JwtService;

  constructor(configService: ConfigService) {
    const baseSecret = configService.get<string>('JWT_SECRET') ?? '';
    this.jwt = new JwtService({
      secret: createHash('sha256')
        .update(`${baseSecret}:${GUEST_ACCESS_PURPOSE}`)
        .digest('hex'),
    });
  }

  /**
   * Emite el token de acceso de un invitado.
   *
   * @param claims - Documento, colaborador y correo de la invitación validada.
   * @returns El token y cuándo vence.
   *
   * @example
   * ```ts
   * const { accessToken } = tokens.issue({ documentId: 'd-1', collaboratorId: 'c-1', email: 'a@b.mx' });
   * ```
   */
  issue(claims: GuestAccessClaims): { accessToken: string; expiresAt: Date } {
    const accessToken = this.jwt.sign(
      {
        purpose: GUEST_ACCESS_PURPOSE,
        documentId: claims.documentId,
        collaboratorId: claims.collaboratorId,
        email: claims.email.toLowerCase(),
      },
      { expiresIn: GUEST_ACCESS_TOKEN_TTL_SECONDS },
    );

    return {
      accessToken,
      expiresAt: new Date(Date.now() + GUEST_ACCESS_TOKEN_TTL_SECONDS * 1000),
    };
  }

  /**
   * Verifica un token de invitado y que corresponda al documento de la petición.
   *
   * @param token - Valor de la cabecera `X-Biometric-Guest-Token`.
   * @param documentId - Documento de la ruta.
   * @returns Lo que acredita el token.
   *
   * @throws {InvalidGuestAccessTokenException} Si falta, venció, está alterado, no es de este
   *   propósito o es de otro documento.
   *
   * @example
   * ```ts
   * const claims = tokens.verify(header, 'd-1');
   * ```
   */
  verify(token: string | undefined, documentId: string): GuestAccessClaims {
    if (!token) {
      throw new InvalidGuestAccessTokenException();
    }

    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify<Record<string, unknown>>(token);
    } catch {
      throw new InvalidGuestAccessTokenException();
    }

    const valid =
      payload.purpose === GUEST_ACCESS_PURPOSE &&
      payload.documentId === documentId &&
      typeof payload.collaboratorId === 'string' &&
      typeof payload.email === 'string';

    if (!valid) {
      throw new InvalidGuestAccessTokenException();
    }

    return {
      documentId,
      collaboratorId: payload.collaboratorId as string,
      email: payload.email as string,
    };
  }
}
