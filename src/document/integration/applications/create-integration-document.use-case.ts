import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { CreateDocumentSignatureFlowUseCase } from '../../applications/create-document-signature-flow.use-case';
import { DocumentReadService } from '../../services/document-read.service';
import { buildPublicDocumentUrl } from '../../utils/document-access-url.util';
import { IntegrationDocumentPayloadDto } from '../dto/create-integration-document.dto';
import { IntegrationCreatedDocumentData } from '../interfaces/integration-document-response';
import { IntegrationCreatorService } from '../services/integration-creator.service';
import { IntegrationIdempotencyService } from '../services/integration-idempotency.service';
import { toCreateDocumentSignaturesDto } from '../utils/integration-payload.mapper';

/** Lo que llega de la petición, ya autenticada y validada. */
export interface CreateIntegrationDocumentRequest {
  apiClient: IntegrationApiClient;
  payload: IntegrationDocumentPayloadDto;
  file: Express.Multer.File;
  ip: string;
  idempotencyKey: string;
  /** SHA-256 del archivo y del payload (`buildRequestFingerprint`). */
  requestHash: string;
}

/** Resultado del alta: el documento y si fue una repetición de una petición anterior. */
export interface CreateIntegrationDocumentResult extends BaseResponse<IntegrationCreatedDocumentData> {
  /** `true` si la clave ya tenía documento y no se creó nada nuevo. */
  replayed: boolean;
}

/**
 * `POST /api/v1/integration/documents`: crea un documento PDF en la organización de la API key, a
 * nombre de un creador identificado por su correo.
 *
 * 1. **Reserva la `Idempotency-Key`** antes de nada costoso. Si ya tiene documento con el mismo
 *    contenido, responde con él sin subir, crear, cobrar ni notificar nada.
 * 2. **Resuelve al creador** (`IntegrationCreatorService`): usa su membresía en la organización o
 *    la crea, y si el correo no existe da de alta un usuario provisional con su cuenta personal.
 * 3. **Crea el documento con el flujo moderno** (`CreateDocumentSignatureFlowUseCase`), con
 *    `createdBy` = creador, `accountId` = su membresía y la llave como origen. La validación del PDF
 *    (tipo y bytes) y de los participantes, MinIO, hash y páginas, la transacción documental, el
 *    crédito, la auditoría, la outbox, Kafka y las notificaciones son los de la plataforma.
 * 4. **Completa la clave** dentro de esa misma transacción; si algo falla, la libera para que el
 *    cliente pueda reintentar.
 *
 * Devuelve la URL pública de consulta armada con `PUBLIC_WEB_APP_URL`, nunca con el `Host` de la
 * petición. Nada del PDF, de la llave ni de los datos del creador se escribe en logs.
 */
@Injectable()
export class CreateIntegrationDocumentUseCase {
  private readonly logger = new Logger(CreateIntegrationDocumentUseCase.name);

  constructor(
    private readonly createDocumentSignatureFlow: CreateDocumentSignatureFlowUseCase,
    private readonly idempotencyService: IntegrationIdempotencyService,
    private readonly integrationCreatorService: IntegrationCreatorService,
    private readonly documentReadService: DocumentReadService,
  ) {}

  /**
   * Crea el documento, o responde con el de una petición anterior con la misma clave.
   *
   * @param request - Cliente autenticado, payload, archivo, IP, clave y huella.
   * @returns El documento creado (o el original) con su URL pública.
   *
   * @throws {IdempotencyKeyMismatchException} (409) Si la clave ya se usó con otro contenido.
   * @throws {IdempotencyKeyInProgressException} (409) Si otra petición con la misma clave sigue en
   *   curso.
   * @throws {IntegrationApprovalNotSupportedException} (400) Si pide aprobación previa.
   * @throws {IntegrationCreatorUnavailableException} (422) Si el creador está desactivado.
   * @throws {IntegrationCreatorMembershipRevokedException} (422) Si fue dado de baja de la
   *   organización.
   * @throws {BadRequestException} (400) Si el PDF o los participantes no pasan las validaciones
   *   del flujo de creación.
   * @throws {InsufficientDocumentCreditsException} (402) Si la organización no tiene créditos.
   *
   * @example
   * ```ts
   * const result = await createIntegrationDocument.execute({ apiClient, payload, file, ip, idempotencyKey, requestHash });
   * result.data.publicUrl; // 'https://app.firmalo.com/public/documents/…'
   * ```
   */
  async execute(
    request: CreateIntegrationDocumentRequest,
  ): Promise<CreateIntegrationDocumentResult> {
    const { apiClient, payload, file, ip, idempotencyKey, requestHash } =
      request;
    const organizationId = apiClient.organizationId;

    // Antes de reservar: un payload que pide aprobación no debe ocupar la clave.
    const dto = toCreateDocumentSignaturesDto(payload, file.originalname);

    const reservation = await this.idempotencyService.reserve({
      apiKeyId: apiClient.apiKeyId,
      idempotencyKey,
      requestHash,
    });
    if (reservation.kind === 'REPLAY') {
      return {
        success: true,
        message: 'El documento ya se había creado con este Idempotency-Key',
        data: await this.loadCreatedDocument(
          organizationId,
          reservation.documentId,
        ),
        replayed: true,
      };
    }

    let documentId: string;
    try {
      const creator = await this.integrationCreatorService.resolve({
        organizationId,
        email: payload.creator.email,
        firstName: payload.creator.firstName,
        lastName: payload.creator.lastName,
        actorUserId: apiClient.actorUserId,
      });

      const created = await this.createDocumentSignatureFlow.execute(
        creator.user.id,
        creator.account.id,
        dto,
        file,
        ip,
        {
          apiKeyId: apiClient.apiKeyId,
          apiKeyName: apiClient.apiKeyName,
          onDocumentSaved: (manager, document) =>
            this.idempotencyService.complete(
              manager,
              reservation.reservationId,
              document.id,
            ),
        },
      );
      documentId = created.data!.id;
    } catch (error) {
      await this.idempotencyService
        .release(reservation.reservationId)
        .catch((releaseError) =>
          this.logger.error(
            `No se pudo liberar la reserva de idempotencia ${reservation.reservationId}: ${releaseError}`,
          ),
        );
      throw error;
    }

    return {
      success: true,
      message: 'Documento y flujo de firmas creados correctamente',
      data: await this.loadCreatedDocument(organizationId, documentId),
      replayed: false,
    };
  }

  private async loadCreatedDocument(
    organizationId: string,
    documentId: string,
  ): Promise<IntegrationCreatedDocumentData> {
    const document = await this.documentReadService.findCreatedDocument(
      organizationId,
      documentId,
    );
    if (!document) {
      // La clave y el documento se escriben en la misma transacción: si falta uno, es un dato roto.
      throw new InternalServerErrorException(
        'No se encontró el documento recién creado',
      );
    }

    return {
      id: document.id,
      status: document.status,
      signatureType: document.signatureType,
      fileName: document.fileName,
      createdAt: document.createdAt,
      creator: { email: document.creatorEmail },
      participantsCount: document.participantsCount,
      publicUrl: buildPublicDocumentUrl(document.id),
    };
  }
}
