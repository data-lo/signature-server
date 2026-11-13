import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

import { RequirePermission } from 'src/authorization/decorators/require-permission.decorator';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { GetIntegrationSettingsUseCase } from './applications/get-integration-settings.use-case';
import { UpdateIntegrationSettingsUseCase } from './applications/update-integration-settings.use-case';
import { UpdateIntegrationSettingsDto } from './dto/update-integration-settings.dto';
import { IntegrationSettingsValidationFilter } from './filters/integration-settings-validation.filter';
import { IntegrationSettingsData } from './interfaces/integration-settings-response.interface';

/** Esquema de `{ success, message, data }` con la configuración. */
const SETTINGS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    message: { type: 'string' },
    data: { $ref: getSchemaPath(IntegrationSettingsData) },
  },
};

/**
 * Administración de la configuración general de la API de integración (sección Integraciones).
 * Se autentica con el JWT de un miembro, no con la API key.
 *
 * Ambos endpoints exigen `API_KEY.MANAGE` sobre la organización de la ruta, el mismo permiso que
 * administra sus llaves: `PermissionsGuard` toma `:organizationId` y resuelve la membresía activa
 * del usuario en ella, así que un miembro de otra organización recibe 403.
 */
@ApiTags('Organization Integration Settings')
@ApiBearerAuth('access-token')
@ApiExtraModels(IntegrationSettingsData)
@UseFilters(IntegrationSettingsValidationFilter)
@Controller('organizations/:organizationId/integration-settings')
export class IntegrationSettingsController {
  constructor(
    private readonly getIntegrationSettings: GetIntegrationSettingsUseCase,
    private readonly updateIntegrationSettings: UpdateIntegrationSettingsUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Consultar la configuración de integración de la organización',
    description:
      'Devuelve si la API de integración está activa. No incluye datos de API keys. Requiere `API_KEY.MANAGE`.',
  })
  @ApiOkResponse({ schema: SETTINGS_RESPONSE_SCHEMA })
  @ApiResponse({
    status: 403,
    description: 'Sin `API_KEY.MANAGE` en la organización.',
  })
  @ApiResponse({ status: 404, description: '`ORGANIZATION_NOT_FOUND`.' })
  @RequirePermission(RESOURCE_KEY_ENUM.API_KEY, ACTION_KEY_ENUM.MANAGE)
  find(@Param('organizationId') organizationId: string) {
    return this.getIntegrationSettings.execute(organizationId);
  }

  @Patch()
  @ApiOperation({
    summary: 'Activar o desactivar la integración de la organización',
    description:
      'Idempotente: repetir el mismo estado no cambia nada. Desactivar no revoca ni rota las API keys; la API de integración responde `403 INTEGRATION_DISABLED` hasta reactivarla. Requiere `API_KEY.MANAGE`.',
  })
  @ApiOkResponse({ schema: SETTINGS_RESPONSE_SCHEMA })
  @ApiResponse({
    status: 403,
    description: 'Sin `API_KEY.MANAGE` en la organización.',
  })
  @ApiResponse({ status: 404, description: '`ORGANIZATION_NOT_FOUND`.' })
  @ApiResponse({
    status: 422,
    description:
      '`INTEGRATION_SETTINGS_INVALID_BODY`: `status` falta o no es válido.',
  })
  @RequirePermission(RESOURCE_KEY_ENUM.API_KEY, ACTION_KEY_ENUM.MANAGE)
  update(
    @Param('organizationId') organizationId: string,
    @Body() dto: UpdateIntegrationSettingsDto,
  ) {
    return this.updateIntegrationSettings.execute(organizationId, dto);
  }
}
