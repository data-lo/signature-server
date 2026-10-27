import { Injectable, InternalServerErrorException } from '@nestjs/common';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { CreateDocumentSignatureFlowUseCase } from '../../applications/create-document-signature-flow.use-case';
import { DocumentReadService } from '../../services/document-read.service';
import { CreateIntegrationDocumentDto } from '../dto/create-integration-document.dto';
import { IdempotencyKeyMismatchException } from '../exceptions/integration-document.exceptions';
import { IntegrationDocumentData } from '../interfaces/integration-document-response';
import {
  IntegrationIdempotencyService,
  isIdempotencyKeyConflict,
} from '../services/integration-idempotency.service';

/** Lo que llega de la petición, ya autenticada. */
export interface CreateIntegrationDocumentRequest {
  apiClient: IntegrationApiClient;
  dto: CreateIntegrationDocumentDto;
  file: Express.Multer.File;
  ip: string;
  idempotencyKey: string;
  /** Huella del archivo y del payload (`buildRequestFingerprint`). */
  requestFingerprint: string;
}

/** Resultado del alta: el documento y si fue una repetición de una petición anterior. */
export interface CreateIntegrationDocumentResult extends BaseResponse<IntegrationDocumentData> {
  /** `true` si la clave ya se había usado y no se creó nada nuevo. */
  replayed: boolean;
}

/**
 * `POST /api/v1/integration/documents`: crea un documento en nombre del actor de la API key.
 *
 * **No reimplementa la creación.** Delega en `CreateDocumentSignatureFlowUseCase` —el flujo de
 * `POST /documents/signatures`— con `createdBy = actorUserId` y `accountId = actorAccountId`, así
 * que la validación del PDF y de los participantes, la carga en MinIO, el hash, el cobro de
 * crédito, la transacción documental, la outbox, Kafka y las notificaciones son exactamente los de
 * la plataforma. Lo propio del origen viaja en `DocumentCreationOrigin`: la llave queda en
 * `documents.created_via_api_key_id` y en el evento de creación.
 *
 * **Idempotencia.** La clave se registra DENTRO de la transacción del alta, antes del cobro:
 * - clave nueva: se crea el documento y se registra la clave, todo o nada;
 * - clave ya usada con la misma huella: no se sube nada ni se cobra; se responde con el documento
 *   original (`replayed: true`);
 * - dos peticiones simultáneas con la misma clave: la segunda choca contra el índice único, su
 *   transacción se deshace sin documento ni crédito, y responde como repetición;
 * - clave ya usada con otro archivo o payload: 409.
 */
@Injectable()
export class CreateIntegrationDocumentUseCase {
  constructor(
    private readonly createDocumentSignatureFlow: CreateDocumentSignatureFlowUseCase,
    private readonly idempotencyService: IntegrationIdempotencyService,
    private readonly documentReadService: DocumentReadService,
  ) {}

  /**
   * Crea el documento, o responde con el de una petición anterior con la misma clave.
   *
   * @param request - Cliente autenticado, payload, archivo, IP, clave y huella.
   * @returns El documento y si fue una repetición.
   *
   * @throws {IdempotencyKeyMismatchException} (409) Si la clave ya se usó con otro contenido.
   * @throws {BadRequestException} (400) Si el payload o el PDF no pasan las validaciones del
   *   flujo de creación.
   * @throws {ForbiddenException} (403) Si el actor ya no es miembro activo de la organización.
   *
   * @example
   * ```ts
   * const result = await createIntegrationDocument.execute({ apiClient, dto, file, ip, idempotencyKey, requestFingerprint });
   * result.replayed; // false la primera vez
   * ```
   */
  async execute(
    request: CreateIntegrationDocumentRequest,
  ): Promise<CreateIntegrationDocumentResult> {
    const { apiClient, dto, file, ip, idempotencyKey, requestFingerprint } =
      request;

    const previous = await this.replayIfUsed(request);
    if (previous) return previous;

    let documentId: string;
    try {
      const created = await this.createDocumentSignatureFlow.execute(
        apiClient.actorUserId,
        apiClient.actorAccountId,
        dto,
        file,
        ip,
        {
          apiKeyId: apiClient.apiKeyId,
          apiKeyName: apiClient.apiKeyName,
          onDocumentSaved: (manager, document) =>
            this.idempotencyService.record(manager, {
              organizationId: apiClient.organizationId,
              apiKeyId: apiClient.apiKeyId,
              idempotencyKey,
              requestFingerprint,
              documentId: document.id,
            }),
        },
      );
      documentId = created.data!.id;
    } catch (error) {
      if (isIdempotencyKeyConflict(error)) {
        const concurrent = await this.replayIfUsed(request);
        if (concurrent) return concurrent;
      }
      throw error;
    }

    return {
      success: true,
      message: 'Documento y flujo de firmas creados correctamente',
      data: await this.loadDocument(apiClient.organizationId, documentId),
      replayed: false,
    };
  }

  /**
   * Si la clave ya se usó en la organización, responde con su documento o rechaza otro contenido.
   *
   * @param request - La petición en curso.
   * @returns La repetición, o `null` si la clave es nueva.
   *
   * @throws {IdempotencyKeyMismatchException} (409) Si la huella no coincide.
   *
   * @example
   * ```ts
   * const previous = await this.replayIfUsed(request);
   * ```
   */
  private async replayIfUsed({
    apiClient,
    idempotencyKey,
    requestFingerprint,
  }: CreateIntegrationDocumentRequest): Promise<CreateIntegrationDocumentResult | null> {
    const used = await this.idempotencyService.find(
      apiClient.organizationId,
      idempotencyKey,
    );
    if (!used) return null;

    if (used.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyKeyMismatchException();
    }

    return {
      success: true,
      message: 'El documento ya se había creado con este Idempotency-Key',
      data: await this.loadDocument(apiClient.organizationId, used.documentId),
      replayed: true,
    };
  }

  private async loadDocument(
    organizationId: string,
    documentId: string,
  ): Promise<IntegrationDocumentData> {
    const document = await this.documentReadService.findOrganizationDocument(
      organizationId,
      documentId,
    );
    if (!document) {
      // La clave y el documento se escriben en la misma transacción: si falta uno, es un dato roto.
      throw new InternalServerErrorException(
        'No se encontró el documento recién creado',
      );
    }
    return document;
  }
}
