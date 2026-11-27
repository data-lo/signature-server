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
  EXAMPLE_INTEGRATION_ADVANCED_DOCUMENT_PAYLOAD,
  EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD,
  EXAMPLE_INTEGRATION_NON_SEQUENTIAL_DOCUMENT_PAYLOAD,
  INVALID_REQUEST_EXAMPLE,
  integrationErrorExample,
} from './api-integration-examples.docs';

/** Header de la respuesta que dice si fue la repetición de una petición anterior. */
const IDEMPOTENT_REPLAYED_RESPONSE_HEADER = {
  'Idempotent-Replayed': {
    description:
      '`true` si la respuesta es la de una petición anterior con la misma `Idempotency-Key`; `false` si se acaba de crear el documento.',
    schema: { type: 'boolean' as const, example: false },
  },
};

/**
 * Respuesta exitosa del alta de `EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD`: tres participantes (dos
 * firmantes y un testigo) y, en `participants`, sólo los firmantes. Marta espera a Luis porque el
 * flujo es secuencial.
 */
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
    participantsCount: 3,
    publicUrl:
      'https://app.firmalo.com/public/documents/2be3b9d7-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
    participants: [
      {
        email: 'luis.martinez@correo.example',
        status: 'PENDING',
        signatureType: 'SIMPLE',
        order: 1,
        taxId: null,
      },
      {
        email: 'marta.gomez@correo.example',
        status: 'WAITING_FOR_PREVIOUS_SIGNER',
        signatureType: 'SIMPLE',
        order: 2,
        taxId: null,
      },
    ],
  },
};

/**
 * Bloque Markdown con un payload de ejemplo. Va en la descripción porque Swagger UI no muestra el
 * selector de `examples` en un cuerpo `multipart/form-data`.
 *
 * @param payload - Payload de ejemplo.
 * @returns El payload como bloque de código JSON.
 *
 * @example
 * ```ts
 * payloadExampleBlock({ document: { isSequential: false } });
 * ```
 */
function payloadExampleBlock(payload: unknown): string {
  return ['```json', JSON.stringify(payload, null, 2), '```'].join('\n');
}

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
      summary: 'Crear un documento para firma',
      description: [
        'Crea un documento a partir de un PDF, invita por correo a sus participantes y devuelve el `id` para consultar su estado. Cada documento consume un crédito de la organización.',
        'Envía `multipart/form-data` con dos campos: el PDF en `file` y los datos del documento en `payload`, como texto JSON con `creator`, `document` y `participants`.',
        [
          '- **Creador.** Se identifica por `creator.email`. Si no es miembro de la organización, se le agrega; si no tiene cuenta, se le crea una provisional. Nunca se cambian los datos de un usuario existente.',
          '- **Orden de firma.** Con `document.isSequential` en `true` (o sin enviarlo), cada `SIGNER` lleva `order` y firman uno a la vez. Con `false`, firman en cualquier orden y `order` no hace falta.',
          '- **Firma avanzada.** Con `document.signatureType: ADVANCED`, cada firmante firma con su e.firma. Envía su RFC en `taxId` para exigir que el certificado sea de ese RFC; sin `taxId`, se compara su nombre con el del certificado.',
          '- **Firma biométrica.** `BIOMETRIC` requiere que el plan la incluya y un crédito biométrico por firmante.',
        ].join('\n'),
        '**Ejemplo de `payload`** (flujo secuencial con dos firmantes y un testigo):',
        payloadExampleBlock(EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD),
        'Para un flujo sin orden, envía `isSequential: false` y quita `order`. Para firma avanzada, cambia `signatureType` a `ADVANCED` y agrega `taxId` al firmante que corresponda.',
      ].join('\n\n'),
    }),
    ApiConsumes('multipart/form-data'),
    ApiExtraModels(IntegrationDocumentPayloadDto),
    ApiBody({
      type: CreateIntegrationDocumentDto,
      examples: {
        sequential: {
          summary: 'Secuencial: dos firmantes y un testigo',
          value: { payload: EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD },
        },
        nonSequential: {
          summary: 'Sin orden de firma',
          value: {
            payload: EXAMPLE_INTEGRATION_NON_SEQUENTIAL_DOCUMENT_PAYLOAD,
          },
        },
        advanced: {
          summary: 'Firma avanzada con el RFC del firmante',
          value: { payload: EXAMPLE_INTEGRATION_ADVANCED_DOCUMENT_PAYLOAD },
        },
      },
    }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', example: EXAMPLE_IDEMPOTENCY_KEY },
      description:
        'Usa una clave nueva por documento, como el folio de tu sistema (1 a 255 caracteres ASCII visibles). Repetir la misma clave con el mismo contenido en las siguientes 24 horas devuelve el documento original sin crear ni cobrar otro.',
    }),
    ApiIntegrationCommonResponses({
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
      forbiddenNote:
        '`FORBIDDEN`: el plan no incluye firma biométrica (`signatureType: BIOMETRIC`).',
      forbiddenExamples: {
        biometricNotIncluded: integrationErrorExample(
          'Plan sin firma biométrica',
          'FORBIDDEN',
          'Tu plan actual no incluye esta funcionalidad.',
        ),
      },
    }),
    ApiResponse({
      status: 201,
      description:
        'Documento creado. Guarda `data.id` para consultarlo; `publicUrl` es la página pública de consulta.',
      type: IntegrationCreatedDocumentResponse,
      headers: IDEMPOTENT_REPLAYED_RESPONSE_HEADER,
      example: CREATED_DOCUMENT_EXAMPLE,
    }),
    ApiResponse({
      status: 200,
      description:
        'Ya existía un documento con esta `Idempotency-Key` y el mismo contenido: se devuelve el original, con `Idempotent-Replayed: true`.',
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
        '`INSUFFICIENT_DOCUMENT_CREDITS`: la organización no tiene créditos de documento. `INSUFFICIENT_BIOMETRIC_CREDITS`: faltan créditos biométricos para todos los firmantes; `details` dice cuántos se necesitan (`required`) y cuántos hay (`available`). No se crea nada: recarga saldo y reintenta con la misma `Idempotency-Key`.',
      type: IntegrationErrorResponseDto,
      examples: {
        noCredits: integrationErrorExample(
          'Sin créditos de documento',
          'INSUFFICIENT_DOCUMENT_CREDITS',
          'No tienes documentos disponibles. Compra más o espera a tu próximo periodo.',
        ),
        noBiometricCredits: integrationErrorExample(
          'Sin créditos biométricos suficientes',
          'INSUFFICIENT_BIOMETRIC_CREDITS',
          'Saldo insuficiente para firmas biométricas.',
          { required: 2, available: 1, biometricSigners: 2 },
        ),
      },
    }),
    ApiResponse({
      status: 409,
      description:
        '`INTEGRATION_IDEMPOTENCY_KEY_MISMATCH`: la clave ya se usó con otro PDF u otro `payload`; usa una clave nueva. `INTEGRATION_IDEMPOTENCY_KEY_IN_PROGRESS`: otra petición con la misma clave sigue en curso; espera unos segundos y repite.',
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
        'El PDF o el `payload` no son válidos. `error.details.field` señala el campo que debes corregir (por ejemplo, `participants[2].email`). Ninguno de estos errores consume la `Idempotency-Key`.',
        '',
        '- Archivo y estructura: `INVALID_DOCUMENT_FILE` (no es un PDF legible o pesa más de 20 MB), `INVALID_PAYLOAD`, `INVALID_CREATOR`, `INVALID_DOCUMENT_OPTIONS`.',
        '- Participantes: `PARTICIPANTS_REQUIRED`, `SIGNER_REQUIRED`, `MAX_PARTICIPANTS_EXCEEDED` (50 por omisión), `INVALID_PARTICIPANT_ROLE`, `INVALID_PARTICIPANT_NAME`, `INVALID_PARTICIPANT_EMAIL`, `DUPLICATE_PARTICIPANT_EMAIL`.',
        '- Orden: `INVALID_SIGNING_ORDER`, `DUPLICATE_SIGNING_ORDER`.',
        '- Posiciones de firma: `SIGNER_SIGNATURE_POSITION_REQUIRED`, `WITNESS_SIGNATURE_POSITION_NOT_ALLOWED`, `MAX_SIGNATURE_POSITIONS_EXCEEDED`, `INVALID_SIGNATURE_POSITION`, `SIGNATURE_POSITION_PAGE_OUT_OF_RANGE`, `SIGNATURE_POSITION_OVERLAP`.',
        '- RFC: `INVALID_PARTICIPANT_TAX_ID`, `PARTICIPANT_TAX_ID_NOT_ALLOWED`, `UNSUPPORTED_PARTICIPANT_FIELD` (envías `rfc`; `details.replacedBy` indica el campo nuevo).',
        '- Creador: `INTEGRATION_CREATOR_UNAVAILABLE`, `INTEGRATION_CREATOR_MEMBERSHIP_REVOKED`.',
      ].join('\n'),
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
        invalidTaxId: integrationErrorExample(
          'RFC del firmante inválido',
          'INVALID_PARTICIPANT_TAX_ID',
          'El taxId del firmante no es un RFC válido: 12 o 13 caracteres (letras, fecha AAMMDD y homoclave).',
          { field: 'participants[0].taxId' },
        ),
        unsupportedParticipantField: integrationErrorExample(
          'Campo retirado del contrato',
          'UNSUPPORTED_PARTICIPANT_FIELD',
          'El campo `rfc` ya no forma parte del contrato: envía el RFC del firmante en `taxId`.',
          {
            field: 'participants[0].rfc',
            replacedBy: 'participants[0].taxId',
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
