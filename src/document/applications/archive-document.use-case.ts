import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentUserPreferenceEntity } from '../preferences/document-user-preference.entity';
import { DocumentService } from '../document.service';

/** Lo que el endpoint devuelve al archivar: el documento y desde cuándo quedó archivado. */
export interface ArchivedDocumentData {
  documentId: string;
  archived: true;
  archivedAt: Date;
}

/**
 * `POST /document/:id/archive`: quien ya terminó con un documento firmado se lo quita de encima.
 *
 * **Archivar es una decisión personal, no un cambio en el documento.** El documento no cambia de
 * estatus, no se borra y no se mueve: lo único que ocurre es que se escribe una fecha en la
 * preferencia del par documento-usuario (ver `DocumentUserPreferenceEntity`). Un contrato que su
 * creador archiva sigue apareciendo, intacto, en la bandeja de cada uno de sus firmantes.
 *
 * **Sólo se archiva lo que ya terminó.** El estado final del dominio es `SIGNED` —firmado por
 * todos— y es el único desde el que tiene sentido: esconder un documento que todavía espera una
 * firma dejaría a su firmante sin la lista donde iba a encontrarlo, y el flujo no tiene otra
 * manera de recordárselo. Los estados terminales por la vía negativa (rechazado, cancelado,
 * expirado) quedan fuera de esta historia a propósito: no viven en la pantalla de Completados,
 * que es la única que ofrece la acción.
 *
 * Esta historia archiva y nada más: no hay endpoint de desarchivado ni pantalla que liste lo
 * archivado. La fecha se guarda igualmente —y no un booleano— porque es la que ordenará esa lista
 * cuando exista, y la que explica qué pasó cuando alguien no encuentra un documento.
 */
@Injectable()
export class ArchiveCompletedDocumentUseCase {
  constructor(
    @InjectRepository(DocumentUserPreferenceEntity)
    private readonly preferenceRepository: Repository<DocumentUserPreferenceEntity>,
    private readonly documentService: DocumentService,
  ) {}

  async execute(
    documentId: string,
    authenticatedUserId: string,
  ): Promise<BaseResponse<ArchivedDocumentData>> {
    /**
     * Mismo criterio de acceso que la descarga y el detalle: creador, colaborador vinculado, o
     * invitado por correo que todavía no vinculó su cuenta. Lanza `NotFoundException` si el
     * documento no existe y `ForbiddenException` si el usuario no participa en él — sin esto,
     * cualquiera con un UUID podría sembrar filas en la bandeja de un documento ajeno.
     */
    const document = await this.documentService.assertUserHasAccess(
      documentId,
      authenticatedUserId,
    );

    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      throw new BadRequestException(
        `El documento no puede archivarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.SIGNED}', el estatus actual es '${document.status}'`,
      );
    }

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
      { documentId, userId: authenticatedUserId, archivedAt },
      { conflictPaths: ['documentId', 'userId'] },
    );

    return {
      success: true,
      message: 'Documento archivado correctamente',
      data: { documentId, archived: true, archivedAt },
    };
  }
}
