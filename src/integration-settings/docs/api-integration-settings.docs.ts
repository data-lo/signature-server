import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { ApiIntegrationCommonResponses } from 'src/document/integration/docs/api-integration-documents-common.docs';
import { integrationErrorExample } from 'src/document/integration/docs/api-integration-examples.docs';
import { IntegrationErrorResponseDto } from 'src/document/integration/interfaces/integration-document-response';

import { UpdateIntegrationApiSettingsDto } from '../dto/update-integration-api-settings.dto';
import { IntegrationApiSettingsResponse } from '../interfaces/integration-api-settings-response.interface';

/** Ejemplo de llave sin el permiso que exige cada endpoint. */
function permissionDeniedExample(permission: string) {
  return {
    permissionDenied: integrationErrorExample(
      'Llave sin el permiso de configuración',
      'API_KEY_PERMISSION_DENIED',
      `La API key no tiene el permiso requerido: ${permission}`,
    ),
  };
}

/**
 * Documentación de `GET /integration/settings`.
 *
 * @returns Decoradores de Swagger.
 *
 * @example
 * ```ts
 * @Get()
 * @ApiGetIntegrationSettings()
 * find() {}
 * ```
 */
export function ApiGetIntegrationSettings() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar la configuración de la integración',
      description: [
        'Devuelve la configuración de la integración de tu organización. Hoy sólo incluye `webhooksEnabled`, que vale `false` hasta que lo cambies.',
        '**Permiso:** `INTEGRATION_SETTINGS.READ`.',
      ].join('\n\n'),
    }),
    ApiIntegrationCommonResponses({
      forbiddenExamples: permissionDeniedExample('INTEGRATION_SETTINGS.READ'),
    }),
    ApiResponse({
      status: 200,
      description: 'Configuración actual.',
      type: IntegrationApiSettingsResponse,
      example: { success: true, data: { webhooksEnabled: false } },
    }),
  );
}

/**
 * Documentación de `PATCH /integration/settings`.
 *
 * @returns Decoradores de Swagger.
 *
 * @example
 * ```ts
 * @Patch()
 * @ApiUpdateIntegrationSettings()
 * update() {}
 * ```
 */
export function ApiUpdateIntegrationSettings() {
  return applyDecorators(
    ApiOperation({
      summary: 'Guardar la preferencia de webhooks',
      description: [
        'Guarda `webhooksEnabled` para toda la organización. Enviar el mismo valor otra vez no cambia nada, y rotar o revocar la API key no lo modifica.',
        'Todavía no cambia qué eventos recibes: el envío de webhooks se está habilitando. La URL y los eventos se configuran con `PUT /api/v1/integration/webhooks/endpoint`.',
        '**Permiso:** `INTEGRATION_SETTINGS.UPDATE`.',
      ].join('\n\n'),
    }),
    ApiBody({
      type: UpdateIntegrationApiSettingsDto,
      examples: {
        enable: { summary: 'Activar', value: { webhooksEnabled: true } },
        disable: { summary: 'Desactivar', value: { webhooksEnabled: false } },
      },
    }),
    ApiIntegrationCommonResponses({
      forbiddenExamples: permissionDeniedExample('INTEGRATION_SETTINGS.UPDATE'),
    }),
    ApiResponse({
      status: 200,
      description: 'Configuración guardada.',
      type: IntegrationApiSettingsResponse,
      example: { success: true, data: { webhooksEnabled: true } },
    }),
    ApiResponse({
      status: 422,
      description:
        '`INVALID_REQUEST`: falta `webhooksEnabled`, no es `true` ni `false`, o el cuerpo trae otros campos. Envía sólo `{ "webhooksEnabled": true }` o `false`.',
      type: IntegrationErrorResponseDto,
      examples: {
        invalid: integrationErrorExample(
          'Valor inválido',
          'INVALID_REQUEST',
          'La petición tiene campos inválidos.',
          { errors: ['webhooksEnabled debe ser true o false'] },
        ),
        unknownField: integrationErrorExample(
          'Campo no admitido',
          'INVALID_REQUEST',
          'La petición tiene campos inválidos.',
          { errors: ['El campo url no se admite'] },
        ),
      },
    }),
  );
}
