import { Controller, Get, Req, UseFilters, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { CurrentApiClient } from 'src/api-key/decorators/current-api-client.decorator';
import { RequireApiKeyPermission } from 'src/api-key/decorators/require-api-key-permission.decorator';
import { ApiKeyPermissionGuard } from 'src/api-key/guards/api-key-permission.guard';
import { OrganizationApiKeyGuard } from 'src/api-key/guards/organization-api-key.guard';
import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { SkipJwtAuth } from 'src/auth/decorators/skip-jwt-auth.decorator';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { PERMISSION_SCOPE_ENUM } from 'src/roles/enums/permission-scope.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { GetIntegrationOrganizationContextUseCase } from './applications/get-integration-organization-context.use-case';
import { INTEGRATION_DOCUMENTS_TAG } from './docs/api-integration-documents-common.docs';
import { ApiGetIntegrationOrganizationContext } from './docs/api-get-integration-organization-context.docs';
import { IntegrationErrorFilter } from './filters/integration-error.filter';
import { assertNoTenantOverrides } from './utils/integration-request.util';

/**
 * Lo que un sistema externo consulta sobre su propia organización, autenticado con la API key. La
 * organización sale siempre de la llave, con los mismos guards y el mismo formato de error que
 * `IntegrationDocumentsController`.
 */
@ApiTags(INTEGRATION_DOCUMENTS_TAG)
@SkipJwtAuth()
@UseGuards(OrganizationApiKeyGuard, ApiKeyPermissionGuard)
@UseFilters(IntegrationErrorFilter)
@Controller('integration/organization')
export class IntegrationOrganizationController {
  constructor(
    private readonly getOrganizationContext: GetIntegrationOrganizationContextUseCase,
  ) {}

  /** Es información de toda la organización: una llave con alcance `OWN` no la ve. */
  @Get('context')
  @ApiGetIntegrationOrganizationContext()
  @RequireApiKeyPermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.READ, [
    PERMISSION_SCOPE_ENUM.ORGANIZATION,
  ])
  getContext(
    @CurrentApiClient() apiClient: IntegrationApiClient,
    @Req() request: Request,
  ) {
    assertNoTenantOverrides(request);
    return this.getOrganizationContext.execute(apiClient);
  }
}
