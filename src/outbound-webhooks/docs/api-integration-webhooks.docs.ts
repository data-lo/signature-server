import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  CallbacksObject,
  ParameterObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { ApiIntegrationCommonResponses } from 'src/document/integration/docs/api-integration-documents-common.docs';
import { integrationErrorExample } from 'src/document/integration/docs/api-integration-examples.docs';
import { IntegrationErrorResponseDto } from 'src/document/integration/interfaces/integration-document-response';

import { UpsertWebhookEndpointDto } from '../dto/upsert-webhook-endpoint.dto';
import { OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM } from '../enums/outbound-webhook-event-type.enum';
import {
  IntegrationWebhookEndpointResponse,
  IntegrationWebhookEndpointWithSecretResponse,
} from '../interfaces/integration-webhook-endpoint-response';
import {
  WEBHOOK_REQUEST_TIMEOUT_MS,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from '../outbound-webhooks.constants';
import {
  WEBHOOK_PAYLOAD_MODELS,
  WebhookPayloadCollaboratorSignedData,
  WebhookPayloadDocument,
  WebhookPayloadDocumentData,
  WebhookPayloadRejectedData,
  WebhookPayloadRejectedParticipant,
  WebhookPayloadSignedParticipant,
} from './webhook-payload-v1.models';

/** Permiso para consultar el endpoint. */
const READ_PERMISSION_NOTE = '**Permiso requerido:** `WEBHOOK.READ`.';

/** Permiso para cambiar el endpoint. */
const MANAGE_PERMISSION_NOTE = '**Permiso requerido:** `WEBHOOK.MANAGE`.';

/** Lo común a la descripción de cada operación. */
function operationDescription(...paragraphs: string[]): string {
  return [
    ...paragraphs,
    'La organización sale de la API key (`X-API-Key`): no se envía ningún identificador.',
  ].join('\n\n');
}

/** Headers de cada entrega, como parámetros de los callbacks. */
const WEBHOOK_DELIVERY_HEADERS: ParameterObject[] = [
  {
    name: 'X-Signature-Webhook-Id',
    in: 'header',
    required: true,
    description:
      'Identificador de la entrega. **No cambia entre reintentos**: deduplica con él o con `id` del payload.',
    schema: { type: 'string', format: 'uuid' },
    example: '3b9d2f61-8c4e-4a7b-9e1d-5f0a2c8b6e43',
  },
  {
    name: 'X-Signature-Event',
    in: 'header',
    required: true,
    description:
      'Tipo de evento; repite `type` para enrutar sin parsear el cuerpo.',
    schema: {
      type: 'string',
      enum: Object.values(OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM),
    },
  },
  {
    name: 'X-Signature-Timestamp',
    in: 'header',
    required: true,
    description: `Segundos Unix, en decimal, del momento en que se firmó este intento. Rechaza la entrega si difiere más de ${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS} s de tu reloj.`,
    schema: { type: 'string', pattern: '^[0-9]+$' },
    example: '1794421800',
  },
  {
    name: 'X-Signature-Hmac',
    in: 'header',
    required: true,
    description:
      '`hex(HMAC-SHA256(secret, timestamp + "." + rawBody))` en hexadecimal minúsculo. Calcúlalo sobre los bytes exactos del cuerpo y compáralo en tiempo constante.',
    schema: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
];

/** Ejemplo del cuerpo de cada evento, igual que en `README.md`. */
const PAYLOAD_EXAMPLES: Record<OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM, unknown> = {
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_COLLABORATOR_SIGNED]: {
    id: '5d0b8c62-2f3e-4a7b-9c1d-6e4f8a2b0c13',
    type: 'document.collaborator_signed',
    version: 1,
    occurredAt: '2026-11-11T18:30:00.000Z',
    data: {
      document: {
        id: '8f25e9d5-8998-4ec5-9a0e-1421ad48f743',
        status: 'PENDING_SIGNATURE',
      },
      participant: {
        id: '77f85c29-0104-4823-8b32-4bc567e88c6a',
        email: 'firmante@empresa.com',
        status: 'SIGNED',
        signedAt: '2026-11-11T18:30:00.000Z',
      },
    },
  },
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_SIGNED]: {
    id: 'a3c9e1f4-7b2d-4e8a-b6c0-1d5f9e3a7c28',
    type: 'document.signed',
    version: 1,
    occurredAt: '2026-11-11T18:30:00.000Z',
    data: {
      document: {
        id: '8f25e9d5-8998-4ec5-9a0e-1421ad48f743',
        status: 'SIGNED',
      },
    },
  },
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_REJECTED]: {
    id: 'c7e2a9b1-4f6d-4c3e-8a0b-9d1e5f7a3b64',
    type: 'document.rejected',
    version: 1,
    occurredAt: '2026-11-11T19:05:00.000Z',
    data: {
      document: {
        id: '8f25e9d5-8998-4ec5-9a0e-1421ad48f743',
        status: 'REJECTED',
      },
      participant: {
        id: '77f85c29-0104-4823-8b32-4bc567e88c6a',
        email: 'firmante@empresa.com',
        status: 'REJECTED',
        rejectedAt: '2026-11-11T19:05:00.000Z',
      },
    },
  },
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_CANCELLED]: {
    id: 'e1f4b7c2-9a3d-4e6b-8c0f-2a5d8e1b4c97',
    type: 'document.cancelled',
    version: 1,
    occurredAt: '2026-11-12T09:00:00.000Z',
    data: {
      document: {
        id: '8f25e9d5-8998-4ec5-9a0e-1421ad48f743',
        status: 'CANCELLED',
      },
    },
  },
};

/** Cuándo ocurre cada evento. */
const EVENT_SUMMARIES: Record<OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM, string> = {
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_COLLABORATOR_SIGNED]:
    'Un participante registró su firma. Si es la última, `data.document.status` ya es `SIGNED` y llega además `document.signed`.',
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_SIGNED]:
    'Todos los firmantes completaron el documento.',
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_REJECTED]:
    'Un firmante rechazó el documento durante la firma. El motivo escrito no se publica.',
  [OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM.DOCUMENT_CANCELLED]:
    'Se confirmó la cancelación del documento.',
};

/**
 * Un callback de OpenAPI por evento: el `POST` que recibe la URL configurada, con sus headers, su
 * cuerpo y las respuestas que el emisor interpreta.
 */
export const WEBHOOK_EVENT_CALLBACKS: CallbacksObject = Object.fromEntries(
  Object.values(OUTBOUND_WEBHOOK_EVENT_TYPE_ENUM).map((event) => [
    event,
    {
      '{$request.body#/url}': {
        post: {
          summary: event,
          description: EVENT_SUMMARIES[event],
          parameters: WEBHOOK_DELIVERY_HEADERS,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: getSchemaPath(WEBHOOK_PAYLOAD_MODELS[event]) },
                example: PAYLOAD_EXAMPLES[event],
              },
            },
          },
          responses: {
            '2XX': {
              description:
                'Entrega confirmada. El cuerpo de la respuesta se ignora.',
            },
            default: {
              description: `Cualquier otra respuesta (incluidas las \`3xx\`), un error de red o ${WEBHOOK_REQUEST_TIMEOUT_MS / 1000} s sin respuesta: se reintenta con el mismo \`X-Signature-Webhook-Id\`.`,
            },
          },
        },
      },
    },
  ]),
);

/** Modelos que sólo aparecen en los callbacks; Swagger no los descubre solo. */
const ApiWebhookPayloadModels = () =>
  ApiExtraModels(
    ...Object.values(WEBHOOK_PAYLOAD_MODELS),
    WebhookPayloadDocument,
    WebhookPayloadSignedParticipant,
    WebhookPayloadRejectedParticipant,
    WebhookPayloadDocumentData,
    WebhookPayloadCollaboratorSignedData,
    WebhookPayloadRejectedData,
  );

/** 404 cuando la organización no configuró su endpoint. */
const ApiWebhookEndpointNotFound = () =>
  ApiResponse({
    status: 404,
    description:
      '`WEBHOOK_ENDPOINT_NOT_FOUND`: la organización no tiene un endpoint configurado. Créalo con `PUT`.',
    type: IntegrationErrorResponseDto,
    examples: {
      notFound: integrationErrorExample(
        'Sin endpoint',
        'WEBHOOK_ENDPOINT_NOT_FOUND',
        'La organización no tiene un endpoint de webhooks configurado',
      ),
    },
  });

/** 503 cuando el servidor no puede cifrar un secreto nuevo. */
const ApiWebhookSecretUnavailable = () =>
  ApiResponse({
    status: 503,
    description:
      '`WEBHOOK_SECRET_ENCRYPTION_UNAVAILABLE`: el servidor no puede generar secretos por ahora. Reintenta más tarde; no se guardó nada.',
    type: IntegrationErrorResponseDto,
    examples: {
      unavailable: integrationErrorExample(
        'Cifrado no disponible',
        'WEBHOOK_SECRET_ENCRYPTION_UNAVAILABLE',
        'La configuración de webhooks no está disponible por ahora. Vuelve a intentarlo más tarde.',
      ),
    },
  });

/**
 * `GET /api/v1/integration/webhooks/endpoint`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiGetIntegrationWebhookEndpoint()
 * ```
 */
export function ApiGetIntegrationWebhookEndpoint() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar el endpoint de webhooks',
      description: operationDescription(
        'Devuelve la URL, el estado, los eventos suscritos y la versión del secreto activo. **Nunca devuelve el secreto.**',
        READ_PERMISSION_NOTE,
      ),
    }),
    ApiIntegrationCommonResponses(),
    ApiResponse({
      status: 200,
      description: 'Configuración del endpoint, sin secreto.',
      type: IntegrationWebhookEndpointResponse,
    }),
    ApiWebhookEndpointNotFound(),
  );
}

/**
 * `PUT /api/v1/integration/webhooks/endpoint`, con los callbacks de los cuatro eventos.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiUpsertIntegrationWebhookEndpoint()
 * ```
 */
export function ApiUpsertIntegrationWebhookEndpoint() {
  return applyDecorators(
    ApiWebhookPayloadModels(),
    ApiOperation({
      summary: 'Crear o actualizar el endpoint de webhooks',
      description: operationDescription(
        'Si la organización no tiene endpoint, lo crea activo y responde `201` con el **secreto**, que sólo se muestra esta vez. Si ya tiene uno, cambia la URL y los eventos, lo reactiva si estaba desactivado y responde `200` sin secreto: el secreto se conserva.',
        'Las entregas ya registradas conservan la URL con la que se registraron.',
        'Los cuerpos de cada evento están en la pestaña **Callbacks**.',
        MANAGE_PERMISSION_NOTE,
      ),
      callbacks: WEBHOOK_EVENT_CALLBACKS,
    }),
    ApiBody({ type: UpsertWebhookEndpointDto }),
    ApiIntegrationCommonResponses(),
    ApiResponse({
      status: 201,
      description:
        'Endpoint creado. `data.secret` es el secreto HMAC; guárdalo ahora.',
      type: IntegrationWebhookEndpointWithSecretResponse,
    }),
    ApiResponse({
      status: 200,
      description: 'Endpoint actualizado. No incluye el secreto.',
      type: IntegrationWebhookEndpointResponse,
    }),
    ApiResponse({
      status: 422,
      description:
        '`WEBHOOK_URL_NOT_ALLOWED` (la URL no es `https://` en el puerto 443, lleva credenciales o apunta a un host privado, reservado o que no resuelve; el motivo va en `details.reason`) o `INVALID_REQUEST` (falta `url`, `events` está vacío, repite un evento o trae uno desconocido).',
      type: IntegrationErrorResponseDto,
      examples: {
        urlNotAllowed: {
          summary: 'URL no permitida',
          value: {
            success: false,
            error: {
              code: 'WEBHOOK_URL_NOT_ALLOWED',
              message: 'La URL del webhook debe usar https://',
              details: { field: 'url', reason: 'HTTPS_REQUIRED' },
            },
          },
        },
      },
    }),
    ApiWebhookSecretUnavailable(),
  );
}

/**
 * `POST /api/v1/integration/webhooks/endpoint/rotate-secret`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiRotateIntegrationWebhookSecret()
 * ```
 */
export function ApiRotateIntegrationWebhookSecret() {
  return applyDecorators(
    ApiOperation({
      summary: 'Rotar el secreto del webhook',
      description: operationDescription(
        'Retira el secreto activo y genera el siguiente, que se devuelve **sólo en esta respuesta**. Las entregas nuevas se firman con él; las ya registradas se siguen firmando con el anterior hasta terminar, así que acepta ambos durante 24 h.',
        MANAGE_PERMISSION_NOTE,
      ),
    }),
    ApiIntegrationCommonResponses(),
    ApiResponse({
      status: 200,
      description: 'Secreto rotado. `data.secret` es el secreto nuevo.',
      type: IntegrationWebhookEndpointWithSecretResponse,
    }),
    ApiWebhookEndpointNotFound(),
    ApiWebhookSecretUnavailable(),
  );
}

/**
 * `DELETE /api/v1/integration/webhooks/endpoint`.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @ApiDisableIntegrationWebhookEndpoint()
 * ```
 */
export function ApiDisableIntegrationWebhookEndpoint() {
  return applyDecorators(
    ApiOperation({
      summary: 'Desactivar el endpoint de webhooks',
      description: operationDescription(
        'Deja de registrar entregas nuevas. Las ya registradas se siguen enviando. No borra la configuración ni el secreto: `PUT` lo reactiva. Repetirlo no cambia nada.',
        MANAGE_PERMISSION_NOTE,
      ),
    }),
    ApiIntegrationCommonResponses(),
    ApiResponse({
      status: 200,
      description: 'Endpoint desactivado (`status: DISABLED`).',
      type: IntegrationWebhookEndpointResponse,
    }),
    ApiWebhookEndpointNotFound(),
  );
}
