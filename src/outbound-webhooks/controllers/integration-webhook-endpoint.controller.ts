import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { CurrentApiClient } from 'src/api-key/decorators/current-api-client.decorator';
import { RequireApiKeyPermission } from 'src/api-key/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard } from 'src/api-key/guards/api-key-permission.guard';
import { OrganizationApiKeyGuard } from 'src/api-key/guards/organization-api-key.guard';
import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { IntegrationErrorFilter } from 'src/document/integration/filters/integration-error.filter';
import { assertNoTenantOverrides } from 'src/document/integration/utils/integration-request.util';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { DisableWebhookEndpointUseCase } from '../applications/disable-webhook-endpoint.use-case';
import { GetWebhookEndpointUseCase } from '../applications/get-webhook-endpoint.use-case';
import { RotateWebhookSecretUseCase } from '../applications/rotate-webhook-secret.use-case';
import { UpsertWebhookEndpointUseCase } from '../applications/upsert-webhook-endpoint.use-case';
import {
  ApiDisableIntegrationWebhookEndpoint,
  ApiGetIntegrationWebhookEndpoint,
  ApiRotateIntegrationWebhookSecret,
  ApiUpsertIntegrationWebhookEndpoint,
} from '../docs/api-integration-webhooks.docs';
import { INTEGRATION_WEBHOOKS_TAG } from '../docs/integration-webhooks-tag.docs';
import { UpsertWebhookEndpointDto } from '../dto/upsert-webhook-endpoint.dto';

/**
 * Configuración del endpoint de webhooks salientes de la organización de la API key: un endpoint
 * por organización, sin identificador en la ruta. Mismos guards y formato de error que el resto de
 * la API de integración; la organización sale siempre de la llave.
 */
@ApiTags(INTEGRATION_WEBHOOKS_TAG)
@SkipJwtAuth()
@UseGuards(OrganizationApiKeyGuard, ApiKeyPermissionGuard)
@UseFilters(IntegrationErrorFilter)
@Controller('integration/webhooks/endpoint')
export class IntegrationWebhookEndpointController {
  constructor(
    private readonly getWebhookEndpoint: GetWebhookEndpointUseCase,
    private readonly upsertWebhookEndpoint: UpsertWebhookEndpointUseCase,
    private readonly rotateWebhookSecret: RotateWebhookSecretUseCase,
    private readonly disableWebhookEndpoint: DisableWebhookEndpointUseCase,
  ) {}

  @Get()
  @ApiGetIntegrationWebhookEndpoint()
  @RequireApiKeyPermission(RESOURCE_KEY_ENUM.WEBHOOK, ACTION_KEY_ENUM.READ, [
    PERMISSION_SCOPE_ENUM.ANY,
  ])
  get(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Req() request: Request,
  ) {
    assertNoTenantOverrides(request);
    return this.getWebhookEndpoint.execute(apiClient);
  }

  /** `201` al crear (con el secreto) y `200` al actualizar (sin él). */
  @Put()
  @ApiUpsertIntegrationWebhookEndpoint()
  @RequireApiKeyPermission(RESOURCE_KEY_ENUM.WEBHOOK, ACTION_KEY_ENUM.MANAGE, [
    PERMISSION_SCOPE_ENUM.ANY,
  ])
  async upsert(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Req() request: Request,
    @Body() dto: UpsertWebhookEndpointDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertNoTenantOverrides(request);
    const result = await this.upsertWebhookEndpoint.execute(apiClient, dto);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.response;
  }

  @Post('rotate-secret')
  @HttpCode(HttpStatus.OK)
  @ApiRotateIntegrationWebhookSecret()
  @RequireApiKeyPermission(RESOURCE_KEY_ENUM.WEBHOOK, ACTION_KEY_ENUM.MANAGE, [
    PERMISSION_SCOPE_ENUM.ANY,
  ])
  rotateSecret(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Req() request: Request,
  ) {
    assertNoTenantOverrides(request);
    return this.rotateWebhookSecret.execute(apiClient);
  }

  @Delete()
  @ApiDisableIntegrationWebhookEndpoint()
  @RequireApiKeyPermission(RESOURCE_KEY_ENUM.WEBHOOK, ACTION_KEY_ENUM.MANAGE, [
    PERMISSION_SCOPE_ENUM.ANY,
  ])
  disable(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Req() request: Request,
  ) {
    assertNoTenantOverrides(request);
    return this.disableWebhookEndpoint.execute(apiClient);
  }
}
