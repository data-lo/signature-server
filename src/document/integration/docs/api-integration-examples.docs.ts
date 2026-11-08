import { ApiResponseExamples } from '@nestjs/swagger';

/**
 * Ejemplos de la documentación de la API de integración. **Todo es ficticio**: ninguna llave,
 * id, correo ni URL sale de un entorno real, y el secreto de la llave lo dice en su propio texto.
 */

/**
 * API key de ejemplo con el formato real `fma_live_<publicId>_<secret>`: 16 hexadecimales y 43
 * caracteres base64url. El secreto es texto legible a propósito, para que nadie lo confunda con uno.
 */
export const EXAMPLE_INTEGRATION_API_KEY =
  'fma_live_0123456789abcdef_EjemploNoRealEjemploNoRealEjemploNoReal1234';

/** `Idempotency-Key` de ejemplo: lo elige el cliente, p. ej. el folio de su propio sistema. */
export const EXAMPLE_IDEMPOTENCY_KEY = 'erp-contrato-2026-000184';

/**
 * Payload JSON de ejemplo del campo multipart `payload` de `POST /integration/documents`, en un flujo
 * secuencial: dos firmantes con `order` y un testigo sin él.
 */
export const EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD = {
  creator: {
    email: 'ana.lopez@cliente.example',
    firstName: 'Ana',
    lastName: 'López',
  },
  document: {
    signatureType: 'SIMPLE',
    isSequential: true,
    isIndexable: true,
  },
  participants: [
    {
      role: 'SIGNER',
      firstName: 'Luis',
      lastName: 'Martínez',
      email: 'luis.martinez@correo.example',
      order: 1,
      signaturePositions: [
        {
          page: 1,
          xRatio: 0.1,
          yRatio: 0.8,
          widthRatio: 0.25,
          heightRatio: 0.08,
        },
      ],
    },
    {
      role: 'SIGNER',
      firstName: 'Marta',
      lastName: 'Gómez',
      email: 'marta.gomez@correo.example',
      order: 2,
      signaturePositions: [
        {
          page: 1,
          xRatio: 0.55,
          yRatio: 0.8,
          widthRatio: 0.25,
          heightRatio: 0.08,
        },
      ],
    },
    {
      role: 'WITNESS',
      firstName: 'Eva',
      lastName: 'Ruiz',
      email: 'eva.ruiz@correo.example',
    },
  ],
};

/**
 * El mismo documento en un flujo no secuencial: los firmantes pueden firmar en cualquier momento,
 * así que nadie lleva `order`.
 */
export const EXAMPLE_INTEGRATION_NON_SEQUENTIAL_DOCUMENT_PAYLOAD = {
  ...EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD,
  document: {
    ...EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD.document,
    isSequential: false,
  },
  participants: EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD.participants.map(
    ({ order: _order, ...participant }) => participant,
  ),
};

/**
 * El mismo documento con firma avanzada (e.firma): el primer firmante trae `taxId`, así que su
 * certificado tiene que ser de ese RFC; el segundo no lo trae y se le compara por nombre. El
 * testigo nunca lleva `taxId`.
 */
export const EXAMPLE_INTEGRATION_ADVANCED_DOCUMENT_PAYLOAD = {
  ...EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD,
  document: {
    ...EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD.document,
    signatureType: 'ADVANCED',
  },
  participants: EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD.participants.map(
    (participant, index) =>
      index === 0 ? { ...participant, taxId: 'MAGL800101AB1' } : participant,
  ),
};

/**
 * Arma un ejemplo de error con la forma de `IntegrationErrorFilter`:
 * `{ success: false, error: { code, message, details? } }`.
 *
 * @param summary - Título corto del ejemplo en Swagger UI.
 * @param code - Código estable del error.
 * @param message - Mensaje legible.
 * @param details - Datos del error, si los tiene.
 * @returns El ejemplo, listo para `ApiResponse({ examples })`.
 *
 * @example
 * ```ts
 * integrationErrorExample('Llave inválida', 'API_KEY_INVALID', 'API key inválida o revocada');
 * ```
 */
export function integrationErrorExample(
  summary: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiResponseExamples {
  return {
    summary,
    value: {
      success: false,
      error: { code, message, ...(details && { details }) },
    },
  };
}

/** 422 del `ValidationPipe` (query o campos del body), que comparten todos los endpoints. */
export const INVALID_REQUEST_EXAMPLE = integrationErrorExample(
  'Campos inválidos',
  'INVALID_REQUEST',
  'La petición tiene campos inválidos.',
  { errors: ['limit must not be greater than 100'] },
);

/** 429 de los límites por firmante (accesos temporales y reenvíos). */
export const TOO_MANY_REQUESTS_EXAMPLE = integrationErrorExample(
  'Demasiadas solicitudes para el firmante',
  'TOO_MANY_REQUESTS',
  'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.',
);
