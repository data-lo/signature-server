import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { InternalPlatformAuth } from 'src/auth/decorators/internal-platform-auth.decorator';

import { CreateOrganizationApiKeyUseCase } from './applications/create-organization-api-key.use-case';
import { GetCurrentOrganizationApiKeyUseCase } from './applications/get-current-organization-api-key.use-case';
import { ListOrganizationApiKeysUseCase } from './applications/list-organization-api-keys.use-case';
import { RevokeOrganizationApiKeyUseCase } from './applications/revoke-organization-api-key.use-case';
import { RotateOrganizationApiKeyUseCase } from './applications/rotate-organization-api-key.use-case';
import { CreateOrganizationApiKeyDto } from './dto/create-organization-api-key.dto';
import { RotateOrganizationApiKeyDto } from './dto/rotate-organization-api-key.dto';

/**
 * Administración exclusiva de las API keys de integración desde los sistemas internos de la
 * plataforma. `@InternalPlatformAuth()` significa autenticación servidor-a-servidor mediante la
 * llave interna `INTERNAL_PLATFORM_API_KEY`, no acceso anónimo (ver `ApiKeyGuard`).
 *
 * Estas rutas no se publican en Swagger ni aceptan JWT de usuarios finales. Así, ningún miembro
 * de una organización cliente puede emitir, consultar, rotar o revocar una llave de integración.
 * La llave creada queda explícitamente marcada sin emisor de organización (`createdByAccountId`
 * nulo) y su validez depende de la organización y de la propia llave, no de un administrador
 * cliente concreto.
 */
@ApiExcludeController()
@InternalPlatformAuth()
@Controller('platform/organizations/:organizationId/api-keys')
export class InternalOrganizationApiKeysController {
  constructor(
    private readonly createOrganizationApiKey: CreateOrganizationApiKeyUseCase,
    private readonly listOrganizationApiKeys: ListOrganizationApiKeysUseCase,
    private readonly getCurrentOrganizationApiKey: GetCurrentOrganizationApiKeyUseCase,
    private readonly rotateOrganizationApiKey: RotateOrganizationApiKeyUseCase,
    private readonly revokeOrganizationApiKey: RevokeOrganizationApiKeyUseCase,
  ) {}

  @Post()
  create(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Body() dto: CreateOrganizationApiKeyDto,
  ) {
    return this.createOrganizationApiKey.execute(
      { organizationId, accountId: null },
      dto,
    );
  }

  @Get()
  findAll(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
  ) {
    return this.listOrganizationApiKeys.execute({
      organizationId,
      accountId: null,
    });
  }

  @Get('current')
  findCurrent(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
  ) {
    return this.getCurrentOrganizationApiKey.execute({
      organizationId,
      accountId: null,
    });
  }

  @Post('rotate')
  rotate(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Body() dto: RotateOrganizationApiKeyDto,
  ) {
    return this.rotateOrganizationApiKey.execute(
      { organizationId, accountId: null },
      dto,
    );
  }

  @Delete(':apiKeyId')
  revoke(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('apiKeyId', new ParseUUIDPipe()) apiKeyId: string,
  ) {
    return this.revokeOrganizationApiKey.execute(
      { organizationId, accountId: null },
      apiKeyId,
    );
  }
}
