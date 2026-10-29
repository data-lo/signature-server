import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';

import { DocumentEntity } from '../entities/document.entity';
import { DocumentService } from '../document.service';
import { DocumentReadAccessService } from '../services/document-read-access.service';

/**
 * `GET /document/file/:id`: URL prefirmada y fresca del archivo, para el visor y la descarga.
 *
 * Autoriza con la MISMA regla que el detalle (`GetDocumentUseCase`). Antes usaba
 * `DocumentService.assertUserHasAccess`, que sólo deja pasar al creador y a los participantes:
 * un administrador con `DOCUMENT.READ_ORGANIZATION` veía el detalle de un documento de su
 * organización y el visor se quedaba sin archivo, porque éste le respondía 403.
 */
@Injectable()
export class GetDocumentFileUrlUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly documentService: DocumentService,
    private readonly readAccess: DocumentReadAccessService,
  ) {}

  /**
   * Genera la URL del archivo tras comprobar que el usuario pueda ver el documento.
   *
   * @param params.documentId - Documento pedido en la ruta.
   * @param params.authorization - Contexto que dejó `PermissionsGuard` para `DOCUMENT + READ`.
   * @param params.asAttachment - Si la URL debe forzar la descarga en vez de abrirse en línea.
   * @returns La URL prefirmada de MinIO y su vigencia.
   *
   * @throws {NotFoundException} (404) Si el documento no existe.
   * @throws {ForbiddenException} (403) Si ningún alcance concedido cubre a este documento.
   *
   * @example
   * ```ts
   * await getDocumentFileUrlUseCase.execute({ documentId: 'doc-1', authorization });
   * ```
   */
  async execute(params: {
    documentId: string;
    authorization: AuthorizationContext;
    asAttachment?: boolean;
  }) {
    const { documentId, authorization, asAttachment = false } = params;

    const document = await this.documentRepository.findOne({
      where: { id: documentId },
      relations: { collaborators: { account: true } },
    });

    if (!document) {
      throw new NotFoundException(
        `El documento con id ${documentId} no se encuentra`,
      );
    }

    const myParticipant = await this.documentService.resolveMyCollaborator(
      document.collaborators,
      authorization.userId,
    );

    await this.readAccess.assertCanRead({
      document,
      authorization,
      participant: myParticipant ?? null,
    });

    return this.documentService.getDocumentMinioURL(documentId, {
      asAttachment,
    });
  }
}
