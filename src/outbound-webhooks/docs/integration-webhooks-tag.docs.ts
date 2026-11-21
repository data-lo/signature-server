import {
  WEBHOOK_MAX_AUTOMATIC_ATTEMPTS,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from '../outbound-webhooks.constants';

/** Tag de Swagger de la configuración y el contrato de los webhooks salientes. */
export const INTEGRATION_WEBHOOKS_TAG = 'Webhooks';

/**
 * Descripción del tag: lo indispensable para aceptar las entregas. El detalle (tabla de reintentos,
 * código de verificación) vive en la guía **Webhooks** del sitio de documentación y en
 * `src/outbound-webhooks/README.md`; los valores salen de `outbound-webhooks.constants.ts`.
 */
export const INTEGRATION_WEBHOOKS_TAG_DESCRIPTION = [
  'Firmalo envía un `POST` firmado a tu URL cuando cambia el estado de firma de un documento creado con la API. Configura la URL y los eventos con estos endpoints; el cuerpo de cada evento está en **Callbacks** de `PUT /api/v1/integration/webhooks/endpoint`. La guía **Webhooks** incluye ejemplos de verificación en Node.js y Python.',
  '**Eventos.** `document.collaborator_signed` (firmó un participante), `document.signed` (firmaron todos), `document.rejected` (un firmante rechazó) y `document.cancelled` (se canceló el documento). Llegan en `X-Signature-Event` y en `type`. La última firma genera `document.collaborator_signed` y `document.signed`, en cualquier orden.',
  `**Verifica cada entrega.** Calcula \`hex(HMAC-SHA256(secret, timestamp + "." + rawBody))\` sobre el cuerpo **crudo**, antes de parsear el JSON, con el valor de \`X-Signature-Timestamp\` como \`timestamp\`. Compáralo en tiempo constante con \`X-Signature-Hmac\` y rechaza la entrega si el timestamp difiere más de ${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS / 60} minutos de tu reloj.`,
  `**Responde rápido.** Un \`2xx\` en menos de ${WEBHOOK_REQUEST_TIMEOUT_MS / 1000} s confirma la entrega. Si no, Firmalo reintenta hasta completar ${WEBHOOK_MAX_AUTOMATIC_ATTEMPTS} intentos en algo más de 24 horas. Una entrega puede llegar repetida o fuera de orden: descarta duplicados por el \`id\` del cuerpo o por \`X-Signature-Webhook-Id\`.`,
  '**Secreto.** Se muestra sólo al crear el endpoint y al rotarlo.',
  'El cuerpo nunca incluye el PDF, URLs, tokens, certificados ni evidencia de firma.',
].join('\n\n');
