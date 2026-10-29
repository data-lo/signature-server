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

/** Payload JSON de ejemplo del campo multipart `payload` de `POST /integration/documents`. */
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
      role: 'WITNESS',
      firstName: 'Eva',
      lastName: 'Ruiz',
      email: 'eva.ruiz@correo.example',
      order: 2,
    },
  ],
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
