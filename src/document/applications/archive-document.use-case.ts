import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { DocumentEntity } from '../entities/document.entity';
import { DocumentUserPreferenceEntity } from '../preferences/document-user-preference.entity';
import { DocumentService } from '../document.service';
import { DocumentReadAccessService } from '../services/document-read-access.service';

/** Lo que el endpoint devuelve al archivar: el documento y desde cuándo quedó archivado. */
export interface ArchivedDocumentData {
  documentId: string;
  archived: true;
  archivedAt: Date;
}

/**
 * `POST /document/:id/archive`: quien ya no quiere ver un documento en su bandeja se lo quita de encima.
 *
 * **Archivar es una decisión personal, no un cambio en el documento.** El documento no cambia de
 * estatus, no se borra y no se mueve: lo único que ocurre es que se escribe una fecha en la
 * preferencia del par documento-usuario (ver `DocumentUserPreferenceEntity`). Un contrato que su
 * creador archiva sigue apareciendo, intacto, en la bandeja de cada uno de sus firmantes.
 *
 * **Se archiva lo que se puede ver.** La autorización es la misma que la del detalle y la del
 * listado: `DOCUMENT + READ`, confrontado con ESTE documento por `DocumentReadAccessService`. Con
 * `DOCUMENT.READ_ORGANIZATION` alcanza cualquier documento de la organización, lo haya creado
 * quien lo haya creado; con `DOCUMENT.READ_OWN`, sólo los propios o aquéllos donde se participa.
 * Antes se exigía ser creador o participante (`DocumentService.assertUserHasAccess`) sin mirar
 * los permisos, así que un administrador veía en su listado un documento ajeno ya firmado, le
 * ofrecían "Archivar" y recibía 403. Como archivar sólo esconde el documento de la bandeja de
 * quien lo pide, no hace falta un permiso más fuerte que el que ya le deja verlo ahí.
 *
 * **Se archiva en cualquier estatus** (historia "Habilitar archivado para todos los archivos,
 * independientemente de su estatus"). Como el documento no cambia, su flujo sigue su curso: un
 * pendiente archivado se puede seguir firmando desde su enlace y no vuelve solo a la bandeja al
 * avanzar. Quien lo archiva deja de verlo en su listado, también en "Por firmar", hasta que lo
 * recupere.
 *
 * Lo archivado se lista con el filtro "Archivados" (`GET /document?archived=true`) y se recupera
 * con `DELETE /document/:id/archive` (`RestoreArchivedDocumentUseCase`). Se guarda una fecha y no
 * un booleano porque es la que explica qué pasó cuando alguien no encuentra un documento.
 */
@Injectable()
export class ArchiveDocumentUseCase {
  constructor(
    @InjectRepository(DocumentUserPreferenceEntity)
    private readonly preferenceRepository: Repository<DocumentUserPreferenceEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly documentService: DocumentService,
    private readonly readAccess: DocumentReadAccessService,
  ) {}

  /**
   * Archiva un documento para el usuario autorizado, sin importar quién lo creó ni su estatus.
   *
   * @param params.documentId - Documento pedido en la ruta.
   * @param params.authorization - Contexto que dejó `PermissionsGuard` (usuario, organización
   *   activa y alcances concedidos para `DOCUMENT + READ`).
   * @returns El documento archivado y la fecha con la que quedó registrado.
   *
   * @throws {NotFoundException} (404) Si el documento no existe.
   * @throws {ForbiddenException} (403) Si ningún alcance de lectura concedido cubre a este
   *   documento — ni en la organización activa ni en la del documento.
   *
   * @example
   * ```ts
   * await archiveDocument.execute({ documentId: 'doc-1', authorization });
   * ```
   */
  async execute(params: {
    documentId: string;
    authorization: AuthorizationContext;
  }): Promise<BaseResponse<ArchivedDocumentData>> {
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

    /**
     * Se resuelve antes de autorizar por lo mismo que en `GetDocumentUseCase`: con sólo
     * `READ_OWN`, un invitado por correo que todavía no vinculó su cuenta sólo se reconoce
     * yendo a la base, y esa consulta es del caso de uso, no de la Policy.
     */
    const participant = await this.documentService.resolveMyCollaborator(
      document.collaborators,
      authorization.userId,
    );

    await this.readAccess.assertCanRead({
      document,
      authorization,
      participant: participant ?? null,
    });

    const archivedAt = new Date();

    /**
     * `upsert` y no "buscar, y crear o actualizar": las dos consultas separadas dejan una ventana
     * entre la lectura y la escritura, y un doble clic en "Archivar" —o la misma persona con dos
     * pestañas abiertas— entra dos veces con el mismo resultado de la lectura ("no existe") y la
     * segunda inserción choca contra `UQ_document_user_preferences_document_user` con un 500.
     *
     * Con un solo `INSERT ... ON CONFLICT DO UPDATE` la carrera la resuelve Postgres: la fila se
     * crea si no estaba y se actualiza si estaba, siempre una sola, sin importar cuántas
     * peticiones simultáneas lleguen. Eso es exactamente lo que pide la idempotencia de esta
     * historia — archivar dos veces no falla ni duplica; sólo mueve la fecha.
     */
    await this.preferenceRepository.upsert(
      { documentId, userId: authorization.userId, archivedAt },
      { conflictPaths: ['documentId', 'userId'] },
    );

    return {
      success: true,
      message: 'Documento archivado correctamente',
      data: { documentId, archived: true, archivedAt },
    };
  }
}
