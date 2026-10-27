import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';

import { OrganizationApiKeyErrorResponse } from 'src/api-key/interfaces/response/organization-api-key-response';

import { CreateIntegrationDocumentDto } from '../dto/create-integration-document.dto';
import { IntegrationDocumentResponse } from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';

/** `POST /api/v1/integration/documents` — alta de un documento con su flujo de firmas. */
export function ApiCreateIntegrationDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear un documento con su flujo de firmas',
      description:
        'Requiere `DOCUMENT.CREATE`. Mismo contrato multipart y mismas reglas que la creación desde la plataforma (`file` PDF, `documentData` y `collaborators` como JSON). La organización y el autor son los de la API key: el documento queda creado por quien emitió la llave, "vía" esa integración, y consume un crédito de la organización. El body no acepta `organizationId`, `taxId`, `accountId`, `createdBy` ni `createdByUserId`.',
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({ type: CreateIntegrationDocumentDto }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        'Valor único elegido por el cliente para este documento (1 a 255 caracteres ASCII visibles). Repetir la petición con la misma clave y el mismo contenido devuelve el documento original sin crear otro ni cobrar de nuevo (`200` con `Idempotent-Replayed: true`).',
    }),
    ApiIntegrationCommonResponses('DOCUMENT.CREATE'),
    ApiResponse({
      status: 201,
      description: 'Documento creado (`Idempotent-Replayed: false`)',
      type: IntegrationDocumentResponse,
    }),
    ApiResponse({
      status: 200,
      description:
        'Repetición de una petición anterior con el mismo `Idempotency-Key`: el documento original (`Idempotent-Replayed: true`)',
      type: IntegrationDocumentResponse,
    }),
    ApiResponse({
      status: 409,
      description:
        '`INTEGRATION_IDEMPOTENCY_KEY_MISMATCH`: la clave ya se usó con otro archivo o con otros datos',
      type: OrganizationApiKeyErrorResponse,
    }),
  );
}
