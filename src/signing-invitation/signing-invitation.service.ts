import { createHash, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';

import { buildSigningInvitationUrl } from 'src/document/utils/document-access-url.util';

import { SigningInvitationEntity } from './entities/signing-invitation.entity';

/** Vigencia por omisión de una invitación: 30 días. */
export const DEFAULT_SIGNING_INVITATION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Bytes aleatorios del token: 32 bytes son 43 caracteres base64url. */
const TOKEN_BYTES = 32;

/**
 * Forma de un token emitido por `SigningInvitationService.issue`: 43 caracteres base64url. Lo que
 * no la tenga no se busca en la base.
 */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** Documento y firmante (con cuenta, usuario y posiciones) de una invitación. */
const INVITATION_RELATIONS = {
  document: true,
  collaborator: { account: { user: true }, simpleSignature: true },
} as const;

/** Lo que se necesita para emitir una invitación. */
export interface IssueSigningInvitationInput {
  documentId: string;
  collaboratorId: string;
  /** Vigencia en segundos; por omisión `DEFAULT_SIGNING_INVITATION_TTL_SECONDS`. */
  ttlSeconds?: number;
}

/** Invitación recién emitida. El token sólo existe aquí: la base guarda su hash. */
export interface IssuedSigningInvitation {
  invitation: SigningInvitationEntity;
  token: string;
  /** `/sign/:token` en la app web pública (`buildSigningInvitationUrl`). */
  url: string;
}

/**
 * Hash con el que se guarda y se busca un token de invitación.
 *
 * @param token - Token completo.
 * @returns SHA-256 en hexadecimal (64 caracteres).
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * hashSigningInvitationToken('q3Vb…'); // 'e3b0c442…'
 * ```
 */
export function hashSigningInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Indica si un valor tiene la forma de un token de invitación.
 *
 * @param token - Lo que llegó en la ruta.
 * @returns `true` si son 43 caracteres base64url.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * isSigningInvitationTokenFormat('abc'); // false
 * ```
 */
export function isSigningInvitationTokenFormat(token: string): boolean {
  return TOKEN_FORMAT.test(token);
}

/**
 * Emite y encuentra las invitaciones individuales de firma (`signing_invitations`), las que abre
 * la pantalla pública `/sign/:token`.
 *
 * El token es aleatorio y opaco: no es el id del documento ni del colaborador, ni los contiene.
 * Sólo se guarda su hash, y nunca se registra en logs.
 */
@Injectable()
export class SigningInvitationService {
  constructor(
    @InjectRepository(SigningInvitationEntity)
    private readonly invitationRepository: Repository<SigningInvitationEntity>,
  ) {}

  /**
   * Emite la invitación de un firmante, revocando antes la que tuviera abierta.
   *
   * Se revoca también una ya vencida: sigue ocupando el lugar del índice único parcial
   * `UQ_signing_invitations_open`, que no puede mirar la hora.
   *
   * @param input - Documento, colaborador y vigencia.
   * @param manager - Transacción del llamador; por omisión, la conexión del repositorio.
   * @returns La invitación, el token completo y su enlace.
   *
   * @throws {QueryFailedError} (23505) Si otra transacción emitió una invitación para el mismo
   *   colaborador al mismo tiempo.
   *
   * @example
   * ```ts
   * const { url } = await invitations.issue({ documentId: 'd-1', collaboratorId: 'c-1' });
   * ```
   */
  async issue(
    input: IssueSigningInvitationInput,
    manager?: EntityManager,
  ): Promise<IssuedSigningInvitation> {
    const repository =
      manager?.getRepository(SigningInvitationEntity) ??
      this.invitationRepository;
    const issuedAt = new Date();
    const ttlSeconds =
      input.ttlSeconds ?? DEFAULT_SIGNING_INVITATION_TTL_SECONDS;

    await repository.update(
      { collaboratorId: input.collaboratorId, revokedAt: IsNull() },
      { revokedAt: issuedAt },
    );

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const invitation = await repository.save(
      repository.create({
        documentId: input.documentId,
        collaboratorId: input.collaboratorId,
        tokenHash: hashSigningInvitationToken(token),
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000),
        revokedAt: null,
      }),
    );

    return { invitation, token, url: buildSigningInvitationUrl(token) };
  }

  /**
   * Busca la invitación de un token, con su documento y su firmante (y la cuenta y el usuario del
   * firmante, si tiene). No decide si sigue sirviendo: eso lo resuelve quien la usa.
   *
   * @param token - Token completo de la ruta.
   * @returns La invitación, o `null` si el token no tiene la forma esperada o no existe.
   *
   * @throws Nada propio; errores de la base.
   *
   * @example
   * ```ts
   * const invitation = await invitations.findByToken(token);
   * ```
   */
  async findByToken(token: string): Promise<SigningInvitationEntity | null> {
    if (!isSigningInvitationTokenFormat(token)) return null;

    return this.invitationRepository.findOne({
      where: { tokenHash: hashSigningInvitationToken(token) },
      relations: INVITATION_RELATIONS,
    });
  }

  /**
   * Busca una invitación por su id, con las mismas relaciones que `findByToken`. La usa la sesión
   * pública, que ya no recibe el token: lo único que conserva es el id de la invitación que la abrió.
   *
   * @param invitationId - Id de la invitación.
   * @returns La invitación, o `null` si no existe.
   *
   * @throws Nada propio; errores de la base.
   *
   * @example
   * ```ts
   * const invitation = await invitations.findById(claims.invitationId);
   * ```
   */
  findById(invitationId: string): Promise<SigningInvitationEntity | null> {
    return this.invitationRepository.findOne({
      where: { id: invitationId },
      relations: INVITATION_RELATIONS,
    });
  }
}
