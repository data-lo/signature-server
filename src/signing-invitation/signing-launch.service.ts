import { createHash, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';

import { buildSigningLaunchUrl } from 'src/document/utils/document-access-url.util';

import { SigningLaunchTokenEntity } from './entities/signing-launch-token.entity';

/** Vigencia de un acceso desde el portal del tercero: cinco minutos. */
export const SIGNING_LAUNCH_TTL_SECONDS = 5 * 60;

/** Prefijo visible del token, para reconocerlo (no es secreto). */
export const SIGNING_LAUNCH_TOKEN_PREFIX = 'sla_';

/** `sla_` + 43 caracteres base64url (32 bytes aleatorios). */
const LAUNCH_TOKEN_FORMAT = /^sla_[A-Za-z0-9_-]{43}$/;

/** Acceso recién emitido. El token sólo existe aquí: la base guarda su hash. */
export interface IssuedSigningLaunch {
  launch: SigningLaunchTokenEntity;
  token: string;
  /** `/sign/launch/:token` (`buildSigningLaunchUrl`). */
  url: string;
}

/**
 * Hash con el que se guarda y se busca un token de lanzamiento.
 *
 * @param token - Token completo.
 * @returns SHA-256 en hexadecimal.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * hashSigningLaunchToken('sla_q3Vb…');
 * ```
 */
export function hashSigningLaunchToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Accesos temporales a la invitación de un firmante desde el portal del tercero
 * (`signing_launch_tokens`).
 *
 * Son de un solo uso y viven minutos: el tercero los pide justo cuando el firmante pulsa "Firmar"
 * en su portal. Canjear uno no autoriza la firma; abre la misma validación del código del correo
 * que la invitación que llega por correo.
 */
@Injectable()
export class SigningLaunchService {
  constructor(
    @InjectRepository(SigningLaunchTokenEntity)
    private readonly launchRepository: Repository<SigningLaunchTokenEntity>,
  ) {}

  /**
   * Emite un acceso para una invitación.
   *
   * @param input - Invitación, API key que lo pide e IP del tercero.
   * @returns El acceso, el token completo y su enlace.
   *
   * @throws Errores de la base.
   *
   * @example
   * ```ts
   * const { url, launch } = await launches.issue({ invitationId: 'inv-1', apiKeyId: 'key-1', ipAddress: '10.0.0.1' });
   * ```
   */
  async issue(input: {
    invitationId: string;
    apiKeyId: string | null;
    ipAddress: string | null;
  }): Promise<IssuedSigningLaunch> {
    const issuedAt = new Date();
    const token = `${SIGNING_LAUNCH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const launch = await this.launchRepository.save(
      this.launchRepository.create({
        invitationId: input.invitationId,
        tokenHash: hashSigningLaunchToken(token),
        issuedAt,
        expiresAt: new Date(
          issuedAt.getTime() + SIGNING_LAUNCH_TTL_SECONDS * 1000,
        ),
        consumedAt: null,
        issuedViaApiKeyId: input.apiKeyId,
        issuedIpAddress: input.ipAddress,
      }),
    );
    return { launch, token, url: buildSigningLaunchUrl(token) };
  }

  /**
   * Canjea un token: lo marca usado si existe, no venció y nadie lo usó, en un solo `UPDATE`
   * condicionado. Dos aperturas simultáneas del mismo enlace: sólo una lo consigue.
   *
   * @param token - Token de la ruta.
   * @param now - Instante de referencia.
   * @returns El acceso canjeado (con su `invitationId`), o `null` si el token no sirve (no existe,
   *   venció o ya se usó: no se distingue).
   *
   * @throws Errores de la base.
   *
   * @example
   * ```ts
   * const launch = await launches.redeem(token);
   * ```
   */
  async redeem(
    token: string,
    now: Date = new Date(),
  ): Promise<SigningLaunchTokenEntity | null> {
    if (!LAUNCH_TOKEN_FORMAT.test(token)) return null;
    const tokenHash = hashSigningLaunchToken(token);

    const claimed = await this.launchRepository.update(
      { tokenHash, consumedAt: IsNull(), expiresAt: MoreThan(now) },
      { consumedAt: now },
    );
    if (claimed.affected !== 1) return null;

    return this.launchRepository.findOne({ where: { tokenHash } });
  }
}
