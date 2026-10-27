import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { DocumentService } from '../document.service';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import {
  DOCUMENT_SORT_FIELD_ENUM,
  SORT_DIRECTION_ENUM,
} from '../enum/document-sort-field.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import {
  applyDocumentStatusAndDateFilters,
  assertValidDocumentDateRanges,
  buildDocumentsPagination,
  DOCUMENT_SORT_COLUMNS,
  DocumentStatusAndDateFilters,
  DocumentsPagination,
} from '../utils/document-list-query.util';

/** Resumen de un documento sin datos personales de nadie: ni colaboradores, ni creador. */
export interface DocumentSummary {
  id: string;
  fileName: string;
  status: DOCUMENT_STATUS_ENUM;
  signatureType: SIGNATURE_TYPE_ENUM | null;
  createdAt: Date;
  signedAt: Date | null;
}

/** Filtros, orden y paginación del listado por organización. */
export interface OrganizationDocumentsFilters extends DocumentStatusAndDateFilters {
  page?: number;
  limit?: number;
  sortBy?: DOCUMENT_SORT_FIELD_ENUM;
  sortDirection?: SORT_DIRECTION_ENUM;
}

/** Qué documentos listar: siempre los de UNA organización y, opcionalmente, de un creador. */
export interface OrganizationDocumentsQuery {
  organizationId: string;
  /** `users.id` del creador; omitido, todos los de la organización. */
  createdBy?: string;
  filters: OrganizationDocumentsFilters;
}

/** Tope de documentos por página, el mismo de la bandeja de la plataforma. */
export const MAX_DOCUMENTS_PAGE_SIZE = 100;

/**
 * Lectura de documentos por organización, sin el contexto de un usuario: ni bandeja personal, ni
 * archivado individual, ni `X-Account-Id`. Es lo que necesita quien consulta en nombre de la
 * organización entera, como la API de integración.
 *
 * El filtro `document.organization_id = :organizationId` se aplica SIEMPRE y antes que cualquier
 * otro: es lo que impide cruzar organizaciones, y no depende de los filtros que mande el cliente.
 * Los filtros de estatus y fechas, el orden y la paginación son los mismos de la bandeja
 * (`document-list-query.util.ts`).
 *
 * Devuelve resúmenes sin URL prefirmada y sin colaboradores: el archivo y los datos de los
 * participantes no viajan si nadie los pidió.
 */
@Injectable()
export class DocumentReadService {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * Una página de documentos de la organización.
   *
   * @param query - Organización, creador opcional y filtros.
   * @returns Los resúmenes de la página y su paginación.
   *
   * @throws {BadRequestException} (400) Si un rango de fechas está al revés.
   *
   * @example
   * ```ts
   * const { items, pagination } = await documentReadService.listOrganizationDocuments({
   *   organizationId: 'org-1',
   *   filters: { page: 1, limit: 25, statuses: [DOCUMENT_STATUS_ENUM.SIGNED] },
   * });
   * ```
   */
  async listOrganizationDocuments({
    organizationId,
    createdBy,
    filters,
  }: OrganizationDocumentsQuery): Promise<{
    items: DocumentSummary[];
    pagination: DocumentsPagination;
  }> {
    const {
      page = 1,
      limit = 25,
      sortBy = DOCUMENT_SORT_FIELD_ENUM.CREATED_AT,
      sortDirection = SORT_DIRECTION_ENUM.DESC,
    } = filters;
    const pageSize = Math.min(limit, MAX_DOCUMENTS_PAGE_SIZE);

    assertValidDocumentDateRanges(filters);

    const qb = this.documentRepository
      .createQueryBuilder('document')
      .where('document.organizationId = :organizationId', { organizationId });

    if (createdBy) {
      qb.andWhere('document.createdBy = :createdBy', { createdBy });
    }

    applyDocumentStatusAndDateFilters(qb, filters);

    const [documents, total] = await qb
      .orderBy(DOCUMENT_SORT_COLUMNS[sortBy], sortDirection)
      .addOrderBy('document.id', sortDirection)
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      items: await this.toSummaries(documents),
      pagination: buildDocumentsPagination(page, pageSize, total),
    };
  }

  /**
   * Un documento de la organización, como resumen.
   *
   * @param organizationId - Organización a la que debe pertenecer.
   * @param documentId - Documento pedido.
   * @returns El resumen, o `null` si no existe en esa organización.
   *
   * @example
   * ```ts
   * await documentReadService.findOrganizationDocument('org-1', 'doc-1');
   * ```
   */
  async findOrganizationDocument(
    organizationId: string,
    documentId: string,
  ): Promise<DocumentSummary | null> {
    const document = await this.documentRepository.findOneBy({
      id: documentId,
      organizationId,
    });

    return document ? (await this.toSummaries([document]))[0] : null;
  }

  /**
   * Proyecta los documentos a su resumen.
   *
   * El tipo de firma sale de la columna del documento; los documentos anteriores a
   * `AddSignatureTypeToDocuments` no la tienen, y para ésos se deduce de sus firmantes con la
   * misma regla de la bandeja (`resolveDocumentSignatureType`), en una sola consulta para toda la
   * página y leyendo sólo tipo y rol —ningún dato personal—.
   *
   * @param documents - Documentos de la página.
   * @returns Sus resúmenes, en el mismo orden.
   *
   * @example
   * ```ts
   * await this.toSummaries(documents);
   * ```
   */
  private async toSummaries(
    documents: DocumentEntity[],
  ): Promise<DocumentSummary[]> {
    const legacyIds = documents
      .filter((document) => !document.signatureType)
      .map((document) => document.id);

    const legacySigners = legacyIds.length
      ? await this.collaboratorRepository.find({
          where: { documentId: In(legacyIds) },
          select: {
            documentId: true,
            colaboratorType: true,
            signatureType: true,
          },
        })
      : [];

    return documents.map((document) => ({
      id: document.id,
      fileName: document.fileName,
      status: document.status,
      signatureType:
        document.signatureType ??
        this.documentService.resolveDocumentSignatureType(
          legacySigners.filter(
            (collaborator) => collaborator.documentId === document.id,
          ),
        ),
      createdAt: document.createdAt,
      signedAt: document.signedAt ?? null,
    }));
  }
}
