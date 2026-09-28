import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { DocumentEntity } from '../entities/document.entity';
import { DocumentUserPreferenceEntity } from '../preferences/document-user-preference.entity';
import { DocumentService } from '../document.service';
import { DocumentReadAccessService } from '../services/document-read-access.service';

/** Lo que el endpoint devuelve al recuperar: el documento, ya fuera de los archivados. */
export interface RestoredDocumentData {
  documentId: string;
  archived: false;
}

/**
 * `DELETE /document/:id/archive`: devuelve un documento archivado a la bandeja de quien lo archivó.
 *
 * Es el inverso exacto de `ArchiveCompletedDocumentUseCase` y por eso comparte sus reglas:
 *
 * - **Es una decisión personal.** Sólo limpia `archived_at` en la preferencia del par
 *   documento-usuario de quien llama. El documento no cambia, y lo que otros hayan archivado sigue
 *   archivado para ellos.
 * - **Se autoriza igual que el detalle y que archivar:** `DOCUMENT + READ` confrontado con ESTE
 *   documento por `DocumentReadAccessService`. Quien ya no puede ver el documento tampoco lo ve
 *   entre sus archivados (el listado aplica la misma Policy), así que no tiene nada que recuperar.
 * - **No mira el estatus.** Archivar exige `SIGNED` para no esconder algo pendiente; recuperar no
 *   esconde nada, así que no hay estatus desde el que no tenga sentido.
 *
 * **Idempotente.** Recuperar un documento que no estaba archivado —o que nunca tuvo preferencia—
 * responde igual que la primera vez: el resultado pedido ("no está archivado") ya se cumple, y un
 * doble clic en "Recuperar" no debe mostrar un error. La fila de preferencia se conserva con
 * `archived_at` en `NULL`, que la entidad define como "sin decisión" igual que la fila ausente.
 */
@Injectable()
export class RestoreArchivedDocumentUseCase {
  constructor(
    @InjectRepository(DocumentUserPreferenceEntity)
    private readonly preferenceRepository: Repository<DocumentUserPreferenceEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly documentService: DocumentService,
    private readonly readAccess: DocumentReadAccessService,
  ) {}

  /**
   * Saca un documento de los archivados del usuario autorizado.
   *
   * Primero autoriza y después escribe: a quien no puede ver el documento no se le confirma que
   * exista una preferencia suya sobre él.
   *
   * @param params.documentId - Documento pedido en la ruta.
   * @param params.authorization - Contexto que dejó `PermissionsGuard` para `DOCUMENT + READ`.
   * @returns El documento y `archived: false`.
   *
   * @throws {NotFoundException} (404) Si el documento no existe.
   * @throws {ForbiddenException} (403) Si ningún alcance de lectura concedido cubre a este
   *   documento — ni en la organización activa ni en la del documento.
   *
   * @example
   * ```ts
   * await restoreArchivedDocument.execute({ documentId: 'doc-1', authorization });
   * ```
   */
  async execute(params: {
    documentId: string;
    authorization: AuthorizationContext;
  }): Promise<BaseResponse<RestoredDocumentData>> {
    const { documentId, authorization } = params;

    const document = await this.documentRepository.findOne({
      where: { id: documentId },
      relations: { collaborators: { account: true } },
    });

    if (!document) {
      throw new NotFoundException(
        `El documento con id ${documentId} no se encuentra`,
      );
    }

    // Igual que al archivar: con sólo `READ_OWN`, un invitado aún sin cuenta vinculada sólo se
    // reconoce yendo a la base, y esa consulta es del caso de uso, no de la Policy.
    const participant = await this.documentService.resolveMyCollaborator(
      document.collaborators,
      authorization.userId,
    );

    await this.readAccess.assertCanRead({
      document,
      authorization,
      participant: participant ?? null,
    });

    // `update` sobre el par (documento, usuario): sin fila no afecta nada, que es justo el
    // resultado pedido. No hace falta leer antes, ni hay carrera que resolver.
    await this.preferenceRepository.update(
      { documentId, userId: authorization.userId },
      { archivedAt: null },
    );

    return {
      success: true,
      message: 'Documento recuperado correctamente',
      data: { documentId, archived: false },
    };
  }
}
