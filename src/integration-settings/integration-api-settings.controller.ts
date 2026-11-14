import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentApiClient } from 'src/api-key/decorators/current-api-client.decorator';
import { RequireApiKeyPermission } from 'src/api-key/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard } from 'src/api-key/guards/api-key-permission.guard';
import { OrganizationApiKeyGuard } from 'src/api-key/guards/organization-api-key.guard';
import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { INTEGRATION_DOCUMENTS_TAG } from 'src/document/integration/docs/api-integration-documents-common.docs';
import { IntegrationErrorFilter } from 'src/document/integration/filters/integration-error.filter';
import { assertNoTenantOverrides } from 'src/document/integration/utils/integration-request.util';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { GetIntegrationApiSettingsUseCase } from './applications/get-integration-api-settings.use-case';
import { UpdateIntegrationApiSettingsUseCase } from './applications/update-integration-api-settings.use-case';
import {
  ApiGetIntegrationSettings,
  ApiUpdateIntegrationSettings,
} from './docs/api-integration-settings.docs';
import {
  UPDATE_INTEGRATION_API_SETTINGS_FIELDS,
  UpdateIntegrationApiSettingsDto,
} from './dto/update-integration-api-settings.dto';

/**
 * Configuración de la integración de la organización, en la API de integración.
 *
 * Se autentica como el resto de `/integration/...`: `X-API-Key` con `OrganizationApiKeyGuard` y el
 * permiso de cada endpoint con `ApiKeyPermissionGuard`. La organización sale sólo de
 * `apiClient.organizationId`; un `organizationId` en el query o el cuerpo se rechaza.
 *
 * Convive con `IntegrationSettingsController` (`/organizations/:organizationId/integration-settings`,
 * JWT), que administra el `status` de la misma fila. Con la integración `DISABLED` el guard rechaza
 * estas rutas con `403 INTEGRATION_DISABLED`, así que la API key no puede reactivarse sola.
 */
@ApiTags(INTEGRATION_DOCUMENTS_TAG)
@SkipJwtAuth()
@UseGuards(OrganizationApiKeyGuard, ApiKeyPermissionGuard)
@UseFilters(IntegrationErrorFilter)
@Controller('integration/settings')
export class IntegrationApiSettingsController {
  constructor(
    private readonly getIntegrationApiSettings: GetIntegrationApiSettingsUseCase,
    private readonly updateIntegrationApiSettings: UpdateIntegrationApiSettingsUseCase,
  ) {}

  @Get()
  @ApiGetIntegrationSettings()
  @RequireApiKeyPermission(
    RESOURCE_KEY_ENUM.INTEGRATION_SETTINGS,
    ACTION_KEY_ENUM.READ,
    [PERMISSION_SCOPE_ENUM.ANY],
  )
  find(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Req() request: Request,
  ) {
    assertNoTenantOverrides(request);
    return this.getIntegrationApiSettings.execute(apiClient);
  }

  @Patch()
  @ApiUpdateIntegrationSettings()
  @RequireApiKeyPermission(
    RESOURCE_KEY_ENUM.INTEGRATION_SETTINGS,
    ACTION_KEY_ENUM.UPDATE,
    [PERMISSION_SCOPE_ENUM.ANY],
  )
  update(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Req() request: Request,
    @Body() dto: UpdateIntegrationApiSettingsDto,
  ) {
    assertNoTenantOverrides(request);
    assertOnlyIntegrationApiSettingsFields(request.body);
    return this.updateIntegrationApiSettings.execute(apiClient, dto);
  }
}

/**
 * Rechaza los campos que el cuerpo no admite. El `ValidationPipe` global sólo los descartaría en
 * silencio, y un cliente que manda una URL, un secreto o un `status` debe saber que no se guardaron.
 *
 * Se llama después de `assertNoTenantOverrides`, para que un `organizationId` siga respondiendo
 * `INTEGRATION_TENANT_OVERRIDE_NOT_ALLOWED` como en el resto de la API de integración.
 *
 * @param body - Cuerpo crudo de la petición, antes del `ValidationPipe`.
 * @returns Nada.
 *
 * @throws {BadRequestException} Con la lista de campos no admitidos; `IntegrationErrorFilter` la
 *   responde como `422 INVALID_REQUEST`.
 *
 * @example
 * ```ts
 * assertOnlyIntegrationApiSettingsFields({ webhooksEnabled: true, url: 'https://…' }); // lanza
 * ```
 */
export function assertOnlyIntegrationApiSettingsFields(body: unknown): void {
  if (!body || typeof body !== 'object') return;

  const unknownFields = Object.keys(body).filter(
    (field) => !UPDATE_INTEGRATION_API_SETTINGS_FIELDS.has(field),
  );
  if (unknownFields.length > 0) {
    throw new BadRequestException(
      unknownFields.map((field) => `El campo ${field} no se admite`),
    );
  }
}
