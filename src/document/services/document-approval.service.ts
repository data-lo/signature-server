import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';

/** Documento y reviewer ya validados, listos para registrar una decisión sobre ellos. */
export interface DecidableApproval {
  document: DocumentEntity;
  reviewer: CollaboratorEntity;
}

/**
 * Las cinco comprobaciones que preceden a aprobar y a rechazar un documento (historia
 * "Implementar flujo de aprobación previo al proceso de firma").
 *
 * Viven juntas y en un solo sitio porque son exactamente las mismas para las dos decisiones: lo
 * único que cambia entre aprobar y rechazar es lo que se escribe después. Repetirlas en los dos
 * casos de uso sería garantizar que algún día una de las dos se quede corta — y la que se quede
 * corta va a ser la que deja firmar un documento que nadie autorizó.
 */
@Injectable()
export class DocumentApprovalService {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
  ) {}

  /**
   * Carga el documento y su reviewer, comprobando que la decisión se pueda tomar.
   *
   * @param documentId - Documento sobre el que se decide.
   * @param currentUserId - Usuario autenticado que dice ser el reviewer.
   * @returns El documento y el colaborador REVIEWER, ambos ya validados.
   *
   * @throws {NotFoundException} (404) Si el documento no existe, o si no tiene reviewer asignado
   *   —un documento que requiere aprobación siempre lo tiene, así que llegar aquí sin él es una
   *   inconsistencia y no un caso de negocio—.
   * @throws {BadRequestException} (400) Si el documento no requiere aprobación, si no está en
   *   `PENDING_APPROVAL`, o si su reviewer ya resolvió (una decisión no se ejecuta dos veces).
   * @throws {ForbiddenException} (403) Si quien llama no es el reviewer asignado.
   *
   * @example
   * ```ts
   * const { document, reviewer } = await documentApprovalService.loadDecidable(
   *   documentId,
   *   user.sub,
   * );
   * ```
   */
  async loadDecidable(
    documentId: string,
    currentUserId: string,
  ): Promise<DecidableApproval> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId },
    });

    if (!document) {
      throw new NotFoundException(
        `Documento con ID ${documentId} no encontrado`,
      );
    }

    if (!document.requiresApproval) {
      throw new BadRequestException('El documento no requiere aprobación');
    }

    /**
     * El estado es la única guarda que hace falta contra la doble decisión a nivel documento:
     * aprobar lo saca de `PENDING_APPROVAL` y rechazar también, así que una segunda petición
     * —un doble clic, un reintento del cliente— se encuentra con un estado que ya no admite
     * decisión. La comprobación del estatus del reviewer, más abajo, cubre el mismo caso desde
     * la otra punta.
     */
    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING_APPROVAL) {
      throw new BadRequestException(
        `El documento no puede aprobarse ni rechazarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.PENDING_APPROVAL}', el estatus actual es '${document.status}'`,
      );
    }

    const reviewer = await this.collaboratorRepository.findOne({
      where: {
        documentId,
        colaboratorType: COLABORATOR_TYPE_ENUM.REVIEWER,
      },
      relations: { account: true },
    });

    if (!reviewer) {
      throw new NotFoundException(
        'El documento no tiene un usuario aprobador asignado',
      );
    }

    /**
     * La identidad se compara contra el usuario dueño de la cuenta del colaborador, no contra la
     * cuenta activa del header: quien aprueba es la persona, y el mismo usuario puede estar
     * operando desde otra de sus cuentas cuando abre el enlace del correo.
     */
    if (reviewer.account?.userId !== currentUserId) {
      throw new ForbiddenException(
        'Solo el usuario aprobador asignado puede aprobar o rechazar este documento',
      );
    }

    if (reviewer.status !== COLLABORATOR_STATUS_ENUM.PENDING) {
      throw new BadRequestException(
        'Ya registraste una decisión sobre este documento',
      );
    }

    return { document, reviewer };
  }
}
