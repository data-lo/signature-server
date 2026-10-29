import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseFilters,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentAuthorization } from 'src/authorization/decorators/current-authorization.decorator';
import { RequirePermission } from 'src/authorization/decorators/require-permission.decorator';
import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { ACTION_KEY_ENUM } from 'src/roles/enums/action-key.enum';
import { RESOURCE_KEY_ENUM } from 'src/roles/enums/resource-key.enum';

import { CreateOrganizationApiKeyUseCase } from './applications/create-organization-api-key.use-case';
import { GetCurrentOrganizationApiKeyUseCase } from './applications/get-current-organization-api-key.use-case';
import { ListOrganizationApiKeysUseCase } from './applications/list-organization-api-keys.use-case';
import { RevokeOrganizationApiKeyUseCase } from './applications/revoke-organization-api-key.use-case';
import { RotateOrganizationApiKeyUseCase } from './applications/rotate-organization-api-key.use-case';
import { ApiCreateOrganizationApiKey } from './docs/api-create-organization-api-key.docs';
import { ApiGetCurrentOrganizationApiKey } from './docs/api-get-current-organization-api-key.docs';
import { ApiListOrganizationApiKeys } from './docs/api-list-organization-api-keys.docs';
import { ApiRevokeOrganizationApiKey } from './docs/api-revoke-organization-api-key.docs';
import { ApiRotateOrganizationApiKey } from './docs/api-rotate-organization-api-key.docs';
import { CreateOrganizationApiKeyDto } from './dto/create-organization-api-key.dto';
import { RotateOrganizationApiKeyDto } from './dto/rotate-organization-api-key.dto';
import { ApiKeyNotFoundException } from './exceptions/api-key.exceptions';
import { ApiKeyValidationFilter } from './filters/api-key-validation.filter';

/**
 * Administración interna de la API key de una organización (sección Integraciones del frontend).
 * No son los endpoints que consumirá la llave: éstos se autentican con el JWT de un miembro.
 *
 * Los cinco exigen `API_KEY.MANAGE` sobre la organización de la ruta: `PermissionsGuard` toma
 * `:organizationId`, resuelve la membresía activa del usuario en ella y deja el contexto en
 * `@CurrentAuthorization()`. Un miembro de otra organización no tiene membresía aquí y recibe 403.
 *
 * Crear una organización NO emite una llave: sólo se emite desde aquí, por acción explícita.
 */
@ApiTags('Organization API Keys')
@ApiBearerAuth('access-token')
@UseFilters(ApiKeyValidationFilter)
@Controller('organizations/:organizationId/api-keys')
export class OrganizationApiKeysController {
  constructor(
    private readonly createOrganizationApiKey: CreateOrganizationApiKeyUseCase,
    private readonly listOrganizationApiKeys: ListOrganizationApiKeysUseCase,
    private readonly getCurrentOrganizationApiKey: GetCurrentOrganizationApiKeyUseCase,
    private readonly rotateOrganizationApiKey: RotateOrganizationApiKeyUseCase,
    private readonly revokeOrganizationApiKey: RevokeOrganizationApiKeyUseCase,
  ) {}

  @Post()
  @ApiCreateOrganizationApiKey()
  @RequirePermission(RESOURCE_KEY_ENUM.API_KEY, ACTION_KEY_ENUM.MANAGE)
  create(
    @Param('organizationId') organizationId: string,
    @CurrentAuthorization() authorization: AuthorizationContext,
    @Body() dto: CreateOrganizationApiKeyDto,
  ) {
    return this.createOrganizationApiKey.execute(
      { organizationId, accountId: authorization.accountId },
      dto,
    );
  }

  @Get()
  @ApiListOrganizationApiKeys()
  @RequirePermission(RESOURCE_KEY_ENUM.API_KEY, ACTION_KEY_ENUM.MANAGE)
  findAll(
    @Param('organizationId') organizationId: string,
    @CurrentAuthorization() authorization: AuthorizationContext,
  ) {
    return this.listOrganizationApiKeys.execute({
      organizationId,
      accountId: authorization.accountId,
    });
  }

  @Get('current')
  @ApiGetCurrentOrganizationApiKey()
  @RequirePermission(RESOURCE_KEY_ENUM.API_KEY, ACTION_KEY_ENUM.MANAGE)
  findCurrent(
    @Param('organizationId') organizationId: string,
    @CurrentAuthorization() authorization: AuthorizationContext,
  ) {
    return this.getCurrentOrganizationApiKey.execute({
      organizationId,
      accountId: authorization.accountId,
    });
  }

  @Post('rotate')
  @ApiRotateOrganizationApiKey()
  @RequirePermission(RESOURCE_KEY_ENUM.API_KEY, ACTION_KEY_ENUM.MANAGE)
  rotate(
    @Param('organizationId') organizationId: string,
    @CurrentAuthorization() authorization: AuthorizationContext,
    @Body() dto: RotateOrganizationApiKeyDto,
  ) {
    return this.rotateOrganizationApiKey.execute(
      { organizationId, accountId: authorization.accountId },
      dto,
    );
  }

  /** Un `apiKeyId` que no es UUID no puede ser una llave de la organización: 404, no 422. */
  @Delete(':apiKeyId')
  @ApiRevokeOrganizationApiKey()
  @RequirePermission(RESOURCE_KEY_ENUM.API_KEY, ACTION_KEY_ENUM.MANAGE)
  revoke(
    @Param('organizationId') organizationId: string,
    @Param(
      'apiKeyId',
      new ParseUUIDPipe({
        exceptionFactory: () => new ApiKeyNotFoundException(),
      }),
    )
    apiKeyId: string,
    @CurrentAuthorization() authorization: AuthorizationContext,
  ) {
    return this.revokeOrganizationApiKey.execute(
      { organizationId, accountId: authorization.accountId },
      apiKeyId,
    );
  }
}
