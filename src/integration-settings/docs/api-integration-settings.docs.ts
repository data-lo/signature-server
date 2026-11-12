import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { ApiIntegrationCommonResponses } from 'src/document/integration/docs/api-integration-documents-common.docs';
import { integrationErrorExample } from 'src/document/integration/docs/api-integration-examples.docs';
import { IntegrationErrorResponseDto } from 'src/document/integration/interfaces/integration-document-response';

import { UpdateIntegrationSettingsDto } from '../dto/update-integration-settings.dto';
import { IntegrationSettingsResponse } from '../interfaces/integration-settings-response.interface';

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
      description:
        'Devuelve las opciones configurables de la integración de tu organización. Hoy sólo `webhooksEnabled`, que es `false` mientras no se haya configurado. La organización sale de la API key. Requiere `INTEGRATION_SETTINGS.READ`; un permiso de documentos no basta.',
    }),
    ApiIntegrationCommonResponses({
      forbiddenNote:
        'Una llave sin `INTEGRATION_SETTINGS.READ` responde `API_KEY_PERMISSION_DENIED`.',
      forbiddenExamples: permissionDeniedExample('INTEGRATION_SETTINGS.READ'),
    }),
    ApiResponse({
      status: 200,
      description:
        'Configuración de la organización, o sus valores por defecto.',
      type: IntegrationSettingsResponse,
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
      summary: 'Activar o desactivar el envío de webhooks',
      description:
        'Fija `webhooksEnabled` para los procesos de firma que tu organización crea con la API; no se configura por documento. Es idempotente: repetir el mismo valor no cambia nada. Rotar o revocar la API key no modifica esta configuración. El cuerpo sólo admite `webhooksEnabled`: la organización sale de la llave, y la URL, el secreto y los eventos se configurarán aparte. Requiere `INTEGRATION_SETTINGS.UPDATE`.',
    }),
    ApiBody({
      type: UpdateIntegrationSettingsDto,
      examples: {
        enable: { summary: 'Activar', value: { webhooksEnabled: true } },
        disable: { summary: 'Desactivar', value: { webhooksEnabled: false } },
      },
    }),
    ApiIntegrationCommonResponses({
      forbiddenNote:
        'Una llave sin `INTEGRATION_SETTINGS.UPDATE` responde `API_KEY_PERMISSION_DENIED`.',
      forbiddenExamples: permissionDeniedExample('INTEGRATION_SETTINGS.UPDATE'),
    }),
    ApiResponse({
      status: 200,
      description: 'Configuración guardada.',
      type: IntegrationSettingsResponse,
      example: { success: true, data: { webhooksEnabled: true } },
    }),
    ApiResponse({
      status: 422,
      description:
        '`INVALID_REQUEST`: falta `webhooksEnabled`, no es booleano, o el cuerpo trae otros campos (por ejemplo, una URL o un secreto).',
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
