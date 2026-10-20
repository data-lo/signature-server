import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';

/** Tipos de firma que un invitado sin cuenta puede completar desde la pantalla pública. */
const PUBLIC_SIGNING_TYPES: ReadonlySet<SIGNATURE_TYPE_ENUM> = new Set([
  SIGNATURE_TYPE_ENUM.BIOMETRIC,
  SIGNATURE_TYPE_ENUM.FIEL,
]);

/** Cómo firma el invitado en la pantalla pública, o `null` si esta invitación no se firma ahí. */
export interface PublicSigningMethod {
  signatureType:
    | SIGNATURE_TYPE_ENUM.BIOMETRIC
    | SIGNATURE_TYPE_ENUM.FIEL
    | null;
}

/**
 * `GET /public/documents/:documentId/signing-method`: qué flujo de firma le toca al invitado del
 * enlace del correo. Lo consulta la pantalla pública `/public/documents/:id/sign` para mostrar el
 * flujo del tipo que exige el documento; el invitado nunca lo elige.
 *
 * El tipo sale del colaborador, que es donde vive (`CreateDocumentSignatureFlowUseCase` lo copia a
 * cada firmante), y sólo se revela si la invitación es de un firmante SIN cuenta vinculada con ese
 * correo: quien tiene cuenta firma desde el dashboard.
 */
@Injectable()
export class GetPublicSigningMethodUseCase {
  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
  ) {}

  /**
   * Resuelve el tipo de firma pública de una invitación.
   *
   * No lanza por una invitación que no aplica (documento o colaborador inexistente, otro correo,
   * cuenta vinculada, firma simple): responde `null`, sin decir por qué, igual que la consulta de
   * invitación biométrica.
   *
   * @param documentId - Documento del enlace.
   * @param collaboratorId - Colaborador del enlace.
   * @param email - Correo del enlace (se compara sin mayúsculas ni espacios). Sólo identifica la
   *   invitación; el acceso lo da después el código enviado al correo guardado.
   * @returns `{ signatureType: 'BIOMETRIC' | 'FIEL' }`, o `{ signatureType: null }`.
   *
   * @example
   * ```ts
   * await getPublicSigningMethod.execute('d-1', 'c-1', 'ana@correo.mx'); // { signatureType: 'BIOMETRIC' }
   * ```
   */
  async execute(
    documentId: string,
    collaboratorId: string,
    email: string,
  ): Promise<PublicSigningMethod> {
    const collaborator = await this.collaboratorRepository.findOne({
      where: {
        id: collaboratorId,
        documentId,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
    });

    const isGuestInvitation =
      !!collaborator &&
      !collaborator.accountId &&
      !!collaborator.email &&
      collaborator.email.trim().toLowerCase() === email.trim().toLowerCase() &&
      !!collaborator.signatureType &&
      PUBLIC_SIGNING_TYPES.has(collaborator.signatureType);

    return {
      signatureType: isGuestInvitation
        ? (collaborator.signatureType as PublicSigningMethod['signatureType'])
        : null,
    };
  }
}
