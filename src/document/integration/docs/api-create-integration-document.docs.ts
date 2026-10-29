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
import {
  IntegrationCreatedDocumentResponse,
  IntegrationErrorResponseDto,
} from '../interfaces/integration-document-response';
import { ApiIntegrationCommonResponses } from './api-integration-documents-common.docs';
import {
  EXAMPLE_IDEMPOTENCY_KEY,
  INVALID_REQUEST_EXAMPLE,
  integrationErrorExample,
} from './api-integration-examples.docs';

/** Header de la respuesta que dice si fue la repetición de una petición anterior. */
const IDEMPOTENT_REPLAYED_RESPONSE_HEADER = {
  'Idempotent-Replayed': {
    description:
      '`false` si se creó el documento; `true` si es la respuesta de una petición anterior con el mismo `Idempotency-Key`',
    schema: { type: 'boolean' as const, example: false },
  },
};

/** Ejemplo de la respuesta exitosa del alta. */
const CREATED_DOCUMENT_EXAMPLE = {
  success: true,
  message: 'Documento y flujo de firmas creados correctamente',
  data: {
    id: '2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    status: 'PENDING_SIGNATURE',
    signatureType: 'SIMPLE',
    fileName: 'contrato.pdf',
    createdAt: '2026-10-26T12:00:00.000Z',
    creator: { email: 'ana.lopez@cliente.example' },
    participantsCount: 2,
    publicUrl:
      'https://app.firmalo.com/public/documents/2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    participants: [
      {
        email: 'luis.martinez@correo.example',
        status: 'PENDING',
        signatureType: 'SIMPLE',
        order: 1,
      },
    ],
  },
};

/**
 * `POST /api/v1/integration/documents` — alta de un documento con creador por correo.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiCreateIntegrationDocument()
 * ```
 */
export function ApiCreateIntegrationDocument() {
  return applyDecorators(
    ApiOperation({
      summary: 'Crear un documento PDF con su flujo de firmas',
      description: [
        'Requiere `DOCUMENT.CREATE`. Es `multipart/form-data` con dos campos: `file` (el PDF, binario) y `payload` (texto con un JSON con `creator`, `document` y `participants`; su estructura es `IntegrationDocumentPayloadDto`).',
        'La organización sale de la API key. El creador se identifica por su correo: si es miembro de la organización se usa su cuenta; si existe sin membresía, se le crea una con el rol `INTEGRATION_DOCUMENT_CREATOR`; si no existe, se crea como usuario provisional (sin contraseña). Sus datos nunca se sobrescriben.',
        'Cada documento creado consume un crédito de la organización. Los participantes se invitan por correo.',
        'Ejemplo con curl:',
        [
          '```bash',
          'curl -X POST https://<host>/api/v1/integration/documents \\',
          '  -H "X-API-Key: $FIRMALO_API_KEY" \\',
          `  -H "Idempotency-Key: ${EXAMPLE_IDEMPOTENCY_KEY}" \\`,
          '  -F "file=@contrato.pdf;type=application/pdf" \\',
          '  -F \'payload={"creator":{"email":"ana.lopez@cliente.example","firstName":"Ana","lastName":"López"},"document":{"signatureType":"SIMPLE","isSequential":true},"participants":[{"role":"SIGNER","firstName":"Luis","lastName":"Martínez","email":"luis.martinez@correo.example","order":1,"signaturePositions":[{"page":1,"xRatio":0.1,"yRatio":0.8,"widthRatio":0.25,"heightRatio":0.08}]}]}\'',
          '```',
        ].join('\n'),
      ].join('\n\n'),
    }),
    ApiConsumes('multipart/form-data'),
    ApiExtraModels(IntegrationDocumentPayloadDto),
    ApiBody({ type: CreateIntegrationDocumentDto }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', example: EXAMPLE_IDEMPOTENCY_KEY },
      description:
        'Valor único elegido por ti para este documento (1 a 255 caracteres ASCII visibles), por API key, durante 24 horas. Repetir la petición con la misma clave y el mismo contenido devuelve el documento original sin subir, crear, cobrar ni notificar nada.',
    }),
    ApiIntegrationCommonResponses('DOCUMENT.CREATE', {
      badRequestExamples: {
        idempotencyKeyRequired: integrationErrorExample(
          'Falta Idempotency-Key',
          'INTEGRATION_IDEMPOTENCY_KEY_REQUIRED',
          'El header Idempotency-Key es obligatorio: de 1 a 255 caracteres ASCII visibles',
        ),
        approvalNotSupported: integrationErrorExample(
          'Aprobación previa no soportada',
          'INTEGRATION_APPROVAL_NOT_SUPPORTED',
          'La API de integración todavía no admite documentos con aprobación previa (requiresApproval: true)',
        ),
      },
    }),
    ApiResponse({
      status: 201,
      description: 'Documento creado, con su URL pública de consulta',
      type: IntegrationCreatedDocumentResponse,
      headers: IDEMPOTENT_REPLAYED_RESPONSE_HEADER,
      example: CREATED_DOCUMENT_EXAMPLE,
    }),
    ApiResponse({
      status: 200,
      description:
        'Repetición de una petición anterior con el mismo `Idempotency-Key`: el documento original (`Idempotent-Replayed: true`)',
      type: IntegrationCreatedDocumentResponse,
      headers: IDEMPOTENT_REPLAYED_RESPONSE_HEADER,
      example: {
        ...CREATED_DOCUMENT_EXAMPLE,
        message: 'El documento ya se había creado con este Idempotency-Key',
      },
    }),
    ApiResponse({
      status: 402,
      description:
        '`INSUFFICIENT_DOCUMENT_CREDITS`: la organización no tiene créditos de documento disponibles. No se crea nada y la `Idempotency-Key` queda libre para reintentar.',
      type: IntegrationErrorResponseDto,
      examples: {
        noCredits: integrationErrorExample(
          'Sin créditos',
          'INSUFFICIENT_DOCUMENT_CREDITS',
          'No tienes documentos disponibles. Compra más o espera a tu próximo periodo.',
        ),
      },
    }),
    ApiResponse({
      status: 409,
      description:
        '`INTEGRATION_IDEMPOTENCY_KEY_MISMATCH` (la clave ya se usó con otro archivo o datos) o `INTEGRATION_IDEMPOTENCY_KEY_IN_PROGRESS` (otra petición con la misma clave sigue en curso).',
      type: IntegrationErrorResponseDto,
      examples: {
        mismatch: integrationErrorExample(
          'Clave reutilizada con otro contenido',
          'INTEGRATION_IDEMPOTENCY_KEY_MISMATCH',
          'Este Idempotency-Key ya se usó con otro archivo o con otros datos. Usa una clave nueva para un documento nuevo.',
        ),
        inProgress: integrationErrorExample(
          'Petición en curso',
          'INTEGRATION_IDEMPOTENCY_KEY_IN_PROGRESS',
          'Ya hay una petición en curso con este Idempotency-Key. Vuelve a intentarlo en unos segundos.',
        ),
      },
    }),
    ApiResponse({
      status: 422,
      description: [
        'Validación del payload o del archivo, con `error.details.field` apuntando al campo (p. ej. `participants[2].email`). Se valida antes de subir el archivo, aprovisionar al creador o reservar la `Idempotency-Key`:',
        '`INVALID_PAYLOAD`, `INVALID_CREATOR`, `INVALID_DOCUMENT_OPTIONS`, `INVALID_DOCUMENT_FILE` (no es un PDF legible o pesa de más);',
        '`PARTICIPANTS_REQUIRED`, `SIGNER_REQUIRED`, `MAX_PARTICIPANTS_EXCEEDED` (50 por omisión), `INVALID_PARTICIPANT_ROLE`, `INVALID_PARTICIPANT_NAME`, `INVALID_PARTICIPANT_EMAIL`, `DUPLICATE_PARTICIPANT_EMAIL` (sin espacios y en minúsculas, aunque cambie el rol);',
        '`SIGNER_SIGNATURE_POSITION_REQUIRED`, `WITNESS_SIGNATURE_POSITION_NOT_ALLOWED`, `MAX_SIGNATURE_POSITIONS_EXCEEDED`, `INVALID_SIGNING_ORDER` / `DUPLICATE_SIGNING_ORDER` (con `isSequential`, `order` único y consecutivo desde 1 entre firmantes);',
        '`INVALID_SIGNATURE_POSITION`, `SIGNATURE_POSITION_PAGE_OUT_OF_RANGE`, `SIGNATURE_POSITION_OVERLAP`;',
        'y `INTEGRATION_CREATOR_UNAVAILABLE` / `INTEGRATION_CREATOR_MEMBERSHIP_REVOKED` para el creador.',
      ].join(' '),
      type: IntegrationErrorResponseDto,
      examples: {
        duplicateParticipant: integrationErrorExample(
          'Participante repetido',
          'DUPLICATE_PARTICIPANT_EMAIL',
          'Un colaborador sólo puede participar una vez en el documento.',
          {
            field: 'participants[1].email',
            email: 'luis.martinez@correo.example',
          },
        ),
        positionOutOfRange: integrationErrorExample(
          'Posición fuera del documento',
          'SIGNATURE_POSITION_PAGE_OUT_OF_RANGE',
          'La posición de firma está en la página 3, pero el documento sólo tiene 2.',
          {
            field: 'participants[0].signaturePositions[0].page',
            page: 3,
            totalPages: 2,
          },
        ),
        invalidFile: integrationErrorExample(
          'El archivo no es un PDF',
          'INVALID_DOCUMENT_FILE',
          'El archivo no es un PDF válido: su contenido no corresponde al tipo declarado',
          { field: 'file' },
        ),
        invalidRequest: INVALID_REQUEST_EXAMPLE,
      },
    }),
  );
}
