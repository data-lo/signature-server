import {
  WEBHOOK_MAX_AUTOMATIC_ATTEMPTS,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from '../outbound-webhooks.constants';

/** Tag de Swagger de la configuración y el contrato de los webhooks salientes. */
export const INTEGRATION_WEBHOOKS_TAG = 'Webhooks';

/**
 * Descripción del tag: lo que un receptor necesita para aceptar las entregas. Es la misma regla que
 * `src/outbound-webhooks/README.md`; los valores salen de `outbound-webhooks.constants.ts`.
 */
export const INTEGRATION_WEBHOOKS_TAG_DESCRIPTION = [
  'Firmalo envía un `POST` firmado a la URL de tu organización cuando cambia el estado de firma de un documento creado por la API de integración. Configura la URL y los eventos con estos endpoints; los cuerpos de cada evento están en la pestaña **Callbacks** de `PUT /api/v1/integration/webhooks/endpoint`.',
  '**Eventos.** `document.collaborator_signed` (un participante firmó), `document.signed` (todos los firmantes completaron el documento), `document.rejected` (un firmante rechazó) y `document.cancelled` (se confirmó la cancelación). La última firma genera `document.collaborator_signed` y `document.signed` como dos eventos independientes; el orden de llegada no está garantizado.',
  '**Headers.** `X-Signature-Webhook-Id` (identificador de la entrega, igual en todos sus reintentos), `X-Signature-Event` (el `type` del evento), `X-Signature-Timestamp` (segundos Unix del momento en que se firmó ese intento) y `X-Signature-Hmac` (firma en hexadecimal minúsculo, 64 caracteres). También `Content-Type: application/json` y `User-Agent: Firmalo-Webhooks/1.0`.',
  '**Firma.** `X-Signature-Hmac = hex(HMAC-SHA256(secret, timestamp + "." + rawBody))`, con el secreto completo (`whsec_` incluido) en UTF-8, el texto exacto de `X-Signature-Timestamp` y los bytes exactos del cuerpo recibido. Para verificar: lee el cuerpo **crudo** antes de parsear el JSON; rechaza si falta un header o si el timestamp difiere más de ' +
    `${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS / 60} minutos de tu reloj; calcula la firma y compárala en tiempo constante.`,
  `**Entrega y reintentos.** Cualquier \`2xx\` confirma la entrega; las redirecciones no se siguen y cuentan como fallo. Cada intento espera ${WEBHOOK_REQUEST_TIMEOUT_MS / 1000} s. Ante un error de red, un timeout o una respuesta distinta de \`2xx\` se reintenta: ${WEBHOOK_MAX_AUTOMATIC_ATTEMPTS} intentos en total (inmediato y a 1 min, 5 min, 30 min, 2 h, 5 h, 10 h y 10 h, algo más de 24 h). Cada reintento lleva un timestamp y una firma nuevos. Agotados, la entrega queda fallida.`,
  '**Al menos una vez.** Una entrega puede llegar repetida o fuera de orden. Deduplica por `id` del payload (mismo evento) o por `X-Signature-Webhook-Id` (misma entrega). Responde `2xx` rápido y procesa después.',
  '**Secreto.** Se entrega sólo al crear el endpoint y al rotarlo; ninguna consulta lo vuelve a mostrar. Tras rotar, las entregas ya registradas se siguen firmando con el secreto anterior hasta terminar: acepta ambos durante 24 h.',
  '**Datos que nunca viajan.** PDF ni su contenido, URLs del archivo, API keys, tokens de firma o invitación, certificados, contraseñas, IP, geolocalización, imágenes o evidencia de firma, datos biométricos, nombre del archivo, motivos escritos de rechazo o cancelación, datos de otros participantes ni datos de pago.',
].join('\n\n');
