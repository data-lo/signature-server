import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiResponse, ApiSecurity } from '@nestjs/swagger';
import { IntegrationErrorResponseDto } from '../interfaces/integration-document-response';

/** Nombre del esquema de seguridad de Swagger para la API key de organización. */
export const INTEGRATION_API_KEY_SECURITY = 'integration-api-key';

/**
 * Lo que comparten los endpoints de integración: el esquema `X-API-Key` y las respuestas de
 * autenticación y autorización de `OrganizationApiKeyGuard`.
 *
 * @param requiredPermission - Permiso que exige el endpoint, para la descripción del 403.
 * @returns Los decoradores de Swagger.
 *
 * @example
 * ```ts
 * ApiIntegrationCommonResponses('DOCUMENT.READ_ORGANIZATION');
 * ```
 */
export function ApiIntegrationCommonResponses(requiredPermission: string) {
  return applyDecorators(
    ApiSecurity(INTEGRATION_API_KEY_SECURITY),
    ApiHeader({
      name: 'X-API-Key',
      required: true,
      description:
        'API key de la organización, `fma_live_<publicId>_<secret>`. Se emite desde Integraciones. No se usan JWT, `X-Account-Id` ni `X-Organization-Id`.',
    }),
    ApiResponse({
      status: 400,
      description:
        '`INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED`: la petición trae `organizationId`, `taxId`, `accountId`, `createdBy`, `createdByUserId`, `X-Account-Id` o `X-Organization-Id` (la organización y el autor salen de la llave); o un filtro inválido',
      type: IntegrationErrorResponseDto,
    }),
    ApiResponse({
      status: 401,
      description:
        '`API_KEY_INVALID` (falta, formato, secreto o revocada) o `API_KEY_EXPIRED`',
      type: IntegrationErrorResponseDto,
    }),
    ApiResponse({
      status: 403,
      description: `\`API_KEY_PERMISSION_DENIED\` (la llave no tiene ${requiredPermission}), \`API_KEY_ORGANIZATION_INACTIVE\` o \`API_KEY_ACTOR_INACTIVE\` (quien emitió la llave ya no es miembro activo)`,
      type: IntegrationErrorResponseDto,
    }),
  );
}
