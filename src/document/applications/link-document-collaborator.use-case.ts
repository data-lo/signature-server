import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { UserService } from 'src/user/user.service';
import { AccountMemberService } from 'src/account/account-member.service';

import { DocumentService } from '../document.service';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { COLLABORATOR_LINK_OUTCOME_ENUM } from '../enum/collaborator-link-outcome.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from '../enum/guest-signing-access-purpose.enum';
import { revokeOpenGuestSigningAccesses } from '../services/guest-signing-access.service';

/** Respuesta de la vinculación de una invitación concreta. */
export interface InvitationLinkResult {
  /** `true` sólo si la cuenta quedó (o ya estaba) vinculada a la invitación. */
  linked: boolean;
  outcome: COLLABORATOR_LINK_OUTCOME_ENUM;
}

/**
 * `PATCH /document/:id/link-collaborator`: engancha la cuenta del usuario autenticado a la
 * invitación que había recibido sólo por correo (ver historia "Notificación por Email para
 * Firma Simple y Vinculación de Cuenta").
 *
 * Existe como endpoint propio porque el frontend lo llama justo después de que alguien completa
 * registro o inicia sesión desde el enlace del correo, antes de redirigirlo al documento. La
 * misma vinculación ocurre de forma perezosa al firmar, pero adelantarla evita que la pantalla
 * de detalle se cargue todavía sin reconocer al usuario como firmante.
 *
 * Dos modos:
 * - **Sin `collaboratorId`** (el de siempre): busca una invitación pendiente del documento con el
 *   correo de la cuenta. No encontrar nada no es un error, responde `linked: false`.
 * - **Con `collaboratorId`** (pantalla pública `/public/documents/:id/sign`): vincula ESA
 *   invitación y responde un `outcome` explícito, para que el frontend distinga "no es tu cuenta"
 *   de "ya estaba vinculada" y sólo abra el dashboard cuando el backend lo confirmó.
 */
@Injectable()
export class LinkDocumentCollaboratorUseCase {
  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly documentService: DocumentService,
    private readonly userService: UserService,
    private readonly accountMemberService: AccountMemberService,
  ) {}

  /**
   * Vincula la cuenta autenticada a una invitación del documento.
   *
   * @param documentId - Documento.
   * @param currentUserId - Usuario autenticado (`sub` del JWT).
   * @param collaboratorId - Invitación concreta (referencia del enlace), u omitido para el modo
   *   anterior por correo.
   * @returns `linked` y, con `collaboratorId`, el `outcome` (ver `linkInvitation`).
   *
   * @throws {NotFoundException} Con `collaboratorId`, si el documento no existe o ese colaborador no
   *   es firmante de él.
   *
   * @example
   * ```ts
   * await linkDocumentCollaborator.execute('d-1', 'u-1', 'c-1'); // { data: { linked: true, outcome: 'LINKED' } }
   * ```
   */
  async execute(
    documentId: string,
    currentUserId: string,
    collaboratorId?: string,
  ): Promise<BaseResponse<{ linked: boolean } | InvitationLinkResult>> {
    if (!collaboratorId) {
      return this.documentService.linkPendingCollaboratorAccount(
        documentId,
        currentUserId,
      );
    }

    const result = await this.linkInvitation(
      documentId,
      collaboratorId,
      currentUserId,
    );
    return {
      success: true,
      message: result.linked
        ? 'Cuenta vinculada correctamente al documento'
        : 'La cuenta activa no corresponde a esta invitación',
      data: result,
    };
  }

  /**
   * Vincula la cuenta a UNA invitación, validando todo del lado del servidor.
   *
   * Reglas:
   * 1. El colaborador tiene que ser firmante del documento.
   * 2. Si ya está vinculado a la cuenta PERSONAL del usuario → `ALREADY_LINKED`; si a otra cuenta →
   *    `ACCOUNT_MISMATCH` (nunca se sustituye).
   * 3. El correo VERIFICADO de la cuenta tiene que ser el de la invitación, comparado exacto sin
   *    distinguir mayúsculas. El cliente no manda ningún correo. Si no coincide → `ACCOUNT_MISMATCH`
   *    y no se toca nada.
   * 4. Sólo se vincula un firmante PENDING → si ya respondió, `NOT_AVAILABLE`.
   * 5. El `UPDATE` va condicionado a `account_id IS NULL` y `PENDING`: de dos vinculaciones
   *    simultáneas sólo una gana; la otra se resuelve releyendo al colaborador.
   * 6. En la misma transacción del `UPDATE` se revocan los accesos de invitado sin cuenta (Firma
   *    Avanzada) del colaborador: desde ahora firma con su cuenta, igual que en
   *    `DocumentService.linkPendingCollaboratorAccount`.
   *
   * @param documentId - Documento.
   * @param collaboratorId - Colaborador de la invitación.
   * @param currentUserId - Usuario autenticado.
   * @returns `linked` y el `outcome`.
   *
   * @throws {NotFoundException} Si el documento no existe, el colaborador no es firmante de él, o el
   *   usuario no tiene cuenta PERSONAL.
   *
   * @example
   * ```ts
   * await this.linkInvitation('d-1', 'c-1', 'u-1'); // { linked: false, outcome: 'ACCOUNT_MISMATCH' }
   * ```
   */
  private async linkInvitation(
    documentId: string,
    collaboratorId: string,
    currentUserId: string,
  ): Promise<InvitationLinkResult> {
    await this.documentService.findOne(documentId);

    const findCollaborator = () =>
      this.collaboratorRepository.findOne({
        where: {
          id: collaboratorId,
          documentId,
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      });

    const collaborator = await findCollaborator();
    if (!collaborator) {
      throw new NotFoundException('Esta invitación no es válida.');
    }

    const personalAccountId =
      await this.accountMemberService.findPersonalAccountId(currentUserId);

    if (collaborator.accountId) {
      return collaborator.accountId === personalAccountId
        ? {
            linked: true,
            outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ALREADY_LINKED,
          }
        : {
            linked: false,
            outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ACCOUNT_MISMATCH,
          };
    }

    const user = await this.userService.findOne(currentUserId);
    const sameEmail =
      user.isEmailVerified !== false &&
      !!user.email &&
      !!collaborator.email &&
      user.email.trim().toLowerCase() ===
        collaborator.email.trim().toLowerCase();

    if (!sameEmail) {
      return {
        linked: false,
        outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ACCOUNT_MISMATCH,
      };
    }

    if (collaborator.status !== COLLABORATOR_STATUS_ENUM.PENDING) {
      return {
        linked: false,
        outcome: COLLABORATOR_LINK_OUTCOME_ENUM.NOT_AVAILABLE,
      };
    }

    const claimed = await this.collaboratorRepository.manager.transaction(
      async (manager) => {
        const claim = await manager.getRepository(CollaboratorEntity).update(
          {
            id: collaborator.id,
            accountId: IsNull(),
            status: COLLABORATOR_STATUS_ENUM.PENDING,
          },
          { accountId: personalAccountId },
        );
        if (claim.affected !== 1) {
          return false;
        }

        await revokeOpenGuestSigningAccesses(
          manager,
          collaborator.id,
          GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
        );
        return true;
      },
    );
    if (claimed) {
      return { linked: true, outcome: COLLABORATOR_LINK_OUTCOME_ENUM.LINKED };
    }

    // Otra petición cambió al colaborador entre la lectura y el UPDATE: se decide con lo que quedó.
    const current = await findCollaborator();
    return current?.accountId === personalAccountId
      ? { linked: true, outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ALREADY_LINKED }
      : {
          linked: false,
          outcome: COLLABORATOR_LINK_OUTCOME_ENUM.ACCOUNT_MISMATCH,
        };
  }
}
