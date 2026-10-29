import { applyDecorators } from '@nestjs/common';
import { ApiResponse, ApiResponseExamples, ApiSecurity } from '@nestjs/swagger';
import { SecuritySchemeObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { IntegrationErrorResponseDto } from '../interfaces/integration-document-response';
import {
  EXAMPLE_INTEGRATION_API_KEY,
  integrationErrorExample,
} from './api-integration-examples.docs';

/** Nombre del esquema de seguridad de Swagger para la API key de organización. */
export const INTEGRATION_API_KEY_SECURITY = 'integration-api-key';

/** Tag de Swagger de la API de integración: el único que publica su documentación propia. */
export const INTEGRATION_DOCUMENTS_TAG = 'Integration Documents';

/**
 * Esquema `X-API-Key` de la API de integración. Lo declaran los dos documentos Swagger (el general
 * de `main.ts` y el de clientes, `createIntegrationOpenApiDocument`) para que digan lo mismo.
 *
 * Es el ÚNICO lugar donde se documenta el header: los endpoints no lo repiten como parámetro, así
 * que en Swagger UI la llave se pega una sola vez, en «Authorize».
 */
export const INTEGRATION_API_KEY_SECURITY_SCHEME: SecuritySchemeObject = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
  description: [
    'API key de tu organización, con formato `fma_live_<publicId>_<secret>`. Se emite (y se rota o revoca) desde **Integraciones** en Firmalo; el secreto completo sólo se muestra al emitirla.',
    `Ejemplo (no es una llave real): \`${EXAMPLE_INTEGRATION_API_KEY}\``,
    'La organización, los permisos y el autor salen de la llave: no se usan JWT, `X-Account-Id` ni `X-Organization-Id`. Llama a la API sólo desde tu backend; nunca expongas la llave en un navegador o una app móvil.',
  ].join('\n\n'),
};

/** Lo que un endpoint agrega a las respuestas comunes. */
export interface IntegrationCommonResponsesOptions {
  /** Ejemplos de 400 propios del endpoint (p. ej. `Idempotency-Key` faltante). */
  badRequestExamples?: Record<string, ApiResponseExamples>;
  /** Aclaración del 403 (p. ej. qué alcance falla con `READ_OWN`). */
  forbiddenNote?: string;
  /** Ejemplos de 403 propios del endpoint. */
  forbiddenExamples?: Record<string, ApiResponseExamples>;
}

/**
 * Lo que comparten los endpoints de integración: el esquema `X-API-Key` y las respuestas 400, 401 y
 * 403 de `assertNoTenantOverrides`, `OrganizationApiKeyGuard` y `ApiKeyPermissionGuard`, con sus
 * ejemplos.
 *
 * @param requiredPermission - Clave del permiso que exige el endpoint (`DOCUMENT.CREATE`), para la
 *   descripción y el ejemplo del 403.
 * @param options - Ejemplos de 400 y 403 propios del endpoint y una aclaración del 403.
 * @returns Los decoradores de Swagger.
 *
 * @example
 * ```ts
 * ApiIntegrationCommonResponses('DOCUMENT.READ_ORGANIZATION');
 * ```
 */
export function ApiIntegrationCommonResponses(
  requiredPermission: string,
  options: IntegrationCommonResponsesOptions = {},
) {
  return applyDecorators(
    ApiSecurity(INTEGRATION_API_KEY_SECURITY),
    ApiResponse({
      status: 400,
      description:
        '`INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED`: la petición trae `organizationId`, `taxId`, `userId`, `accountId`, `createdBy`, `createdByUserId`, `permissionIds`, `X-Account-Id` o `X-Organization-Id` (la organización y el autor salen de la llave).',
      type: IntegrationErrorResponseDto,
      examples: {
        tenantOverride: integrationErrorExample(
          'Campo de organización o autor no permitido',
          'INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED',
          'La organización, la cuenta y el autor salen de la API key; no se aceptan: organizationId',
        ),
        ...options.badRequestExamples,
      },
    }),
    ApiResponse({
      status: 401,
      description:
        '`API_KEY_INVALID` (falta, formato incorrecto, secreto que no coincide o llave revocada) o `API_KEY_EXPIRED`.',
      type: IntegrationErrorResponseDto,
      examples: {
        invalid: integrationErrorExample(
          'Llave ausente, inválida o revocada',
          'API_KEY_INVALID',
          'API key inválida o revocada',
        ),
        expired: integrationErrorExample(
          'Llave vencida',
          'API_KEY_EXPIRED',
          'La API key venció. Genera una nueva desde Integraciones.',
        ),
      },
    }),
    ApiResponse({
      status: 403,
      description: [
        `\`API_KEY_PERMISSION_DENIED\` (la llave no tiene \`${requiredPermission}\`), \`API_KEY_ORGANIZATION_INACTIVE\` o \`API_KEY_ACTOR_INACTIVE\` (quien emitió la llave ya no es miembro activo).`,
        options.forbiddenNote,
      ]
        .filter(Boolean)
        .join(' '),
      type: IntegrationErrorResponseDto,
      examples: {
        permissionDenied: integrationErrorExample(
          'Permiso faltante',
          'API_KEY_PERMISSION_DENIED',
          `La API key no tiene el permiso requerido: ${requiredPermission}`,
        ),
        organizationInactive: integrationErrorExample(
          'Organización desactivada',
          'API_KEY_ORGANIZATION_INACTIVE',
          'La organización de esta API key está desactivada',
        ),
        ...options.forbiddenExamples,
      },
    }),
  );
}
