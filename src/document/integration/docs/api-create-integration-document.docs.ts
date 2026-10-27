import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiHeader,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';

import {
  CreateIntegrationDocumentDto,
  IntegrationDocumentPayloadDto,
} from '../dto/create-integration-document.dto';
import { IntegrationCreatedDocumentResponse } from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';
import { IntegrationErrorResponseDto } from '../interfaces/integration-document-response';

/** `POST /api/v1/integration/documents` — alta de un documento con creador por correo. */
export function ApiCreateIntegrationDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear un documento PDF con su flujo de firmas',
      description: [
        'Requiere `DOCUMENT.CREATE`. Recibe el PDF como archivo binario (`file`) y un JSON (`payload`, ver `IntegrationDocumentPayloadDto`) con `creator`, `document` y `participants`.',
        'La organización sale de la API key. El creador se identifica por su correo: si es miembro de la organización se usa su cuenta; si existe sin membresía, se le crea una con el rol `INTEGRATION_DOCUMENT_CREATOR`; si no existe, se crea como usuario provisional (sin contraseña) con su cuenta personal y esa membresía. Sus datos nunca se sobrescriben.',
        'El documento pasa por las mismas validaciones y el mismo alta que desde la plataforma (PDF real, participantes, posiciones, créditos, auditoría, eventos y notificaciones). Los participantes se invitan por correo.',
        'No se aceptan `organizationId`, `taxId`, `userId`, `accountId`, `createdBy`, `permissionIds` ni `documentBase64`.',
      ].join('\n\n'),
    }),
    ApiConsumes('multipart/form-data'),
    ApiExtraModels(IntegrationDocumentPayloadDto),
    ApiBody({ type: CreateIntegrationDocumentDto }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        'Valor único elegido por el cliente para este documento (1 a 255 caracteres ASCII visibles), por API key, durante 24 horas. Repetir la petición con la misma clave y el mismo contenido devuelve el documento original sin subir, crear, cobrar ni notificar nada (`200` con `Idempotent-Replayed: true`).',
    }),
    ApiIntegrationCommonResponses('DOCUMENT.CREATE'),
    ApiResponse({
      status: 201,
      description:
        'Documento creado, con su URL pública de consulta (`Idempotent-Replayed: false`)',
      type: IntegrationCreatedDocumentResponse,
    }),
    ApiResponse({
      status: 200,
      description:
        'Repetición de una petición anterior con el mismo `Idempotency-Key`: el documento original (`Idempotent-Replayed: true`)',
      type: IntegrationCreatedDocumentResponse,
    }),
    ApiResponse({
      status: 402,
      description: 'La organización no tiene créditos de documento disponibles',
    }),
    ApiResponse({
      status: 409,
      description:
        '`INTEGRATION_IDEMPOTENCY_KEY_MISMATCH` (la clave ya se usó con otro archivo o datos) o `INTEGRATION_IDEMPOTENCY_KEY_IN_PROGRESS` (otra petición con la misma clave sigue en curso)',
      type: IntegrationErrorResponseDto,
    }),
    ApiResponse({
      status: 422,
      description: [
        'Validación del payload o del archivo, con `error.details.field` apuntando al campo (p. ej. `participants[2].email`). Se valida antes de subir el archivo, aprovisionar al creador o reservar la `Idempotency-Key`:',
        '`INVALID_PAYLOAD`, `INVALID_CREATOR`, `INVALID_DOCUMENT_OPTIONS`, `INVALID_DOCUMENT_FILE` (no es un PDF legible o pesa de más);',
        '`PARTICIPANTS_REQUIRED`, `SIGNER_REQUIRED`, `MAX_PARTICIPANTS_EXCEEDED` (`MAX_INTEGRATION_DOCUMENT_PARTICIPANTS`, 50 por omisión), `INVALID_PARTICIPANT_ROLE`, `INVALID_PARTICIPANT_NAME`, `INVALID_PARTICIPANT_EMAIL`, `DUPLICATE_PARTICIPANT_EMAIL` (sin espacios y en minúsculas, aunque cambie el rol);',
        '`SIGNER_SIGNATURE_POSITION_REQUIRED`, `WITNESS_SIGNATURE_POSITION_NOT_ALLOWED`, `MAX_SIGNATURE_POSITIONS_EXCEEDED`, `INVALID_SIGNING_ORDER` / `DUPLICATE_SIGNING_ORDER` (con `isSequential`, `order` único y consecutivo desde 1 entre firmantes);',
        '`INVALID_SIGNATURE_POSITION`, `SIGNATURE_POSITION_PAGE_OUT_OF_RANGE`, `SIGNATURE_POSITION_OVERLAP`;',
        'y `INTEGRATION_CREATOR_UNAVAILABLE` / `INTEGRATION_CREATOR_MEMBERSHIP_REVOKED` para el creador.',
      ].join(' '),
      type: IntegrationErrorResponseDto,
    }),
  );
}
