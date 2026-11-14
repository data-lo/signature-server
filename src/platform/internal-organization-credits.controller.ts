import {
  Body,
  Controller,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';

import { InternalPlatformAuth } from 'src/auth/decorators/internal-platform-auth.decorator';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { GrantOrganizationCreditsUseCase } from './applications/grant-organization-credits.use-case';
import { GrantOrganizationCreditsDto } from './dto/grant-organization-credits.dto';
import { OrganizationCreditGrantData } from './interfaces/grant-organization-credits-response';
import {
  PROVISIONING_REPLAYED_HEADER,
  readProvisioningIdempotencyKey,
} from './internal-organization-provisioning.controller';

/**
 * Recargas internas de créditos de una organización Enterprise ya existente.
 *
 * - `@InternalPlatformAuth()`: sólo `INTERNAL_PLATFORM_API_KEY` en `x-api-key`; sin JWT, sin
 *   `API_KEY` de servicios y sin llaves `fma_live_*`.
 * - `@ApiExcludeController()`: no se publica en Swagger (y su módulo tampoco está en el `include`
 *   del documento público de `main.ts`).
 */
@ApiExcludeController()
@InternalPlatformAuth()
@Controller('platform/organizations/:organizationId/credits')
export class InternalOrganizationCreditsController {
  constructor(private readonly grantCredits: GrantOrganizationCreditsUseCase) {}

  /**
   * `POST /api/v1/platform/organizations/:organizationId/credits`: acredita una recarga.
   *
   * Responde 201 la primera vez, y 200 con `replayed: true` y el header `Idempotent-Replayed: true`
   * al repetir la misma `Idempotency-Key` con los mismos datos.
   *
   * @param organizationId - Organización que recibe los créditos.
   * @param dto - Body validado.
   * @param idempotencyKeyHeader - Header `Idempotency-Key`.
   * @param response - Para fijar el estado y el header de repetición.
   * @returns La recarga, el saldo actualizado y si fue una repetición.
   *
   * @throws {BadRequestException} (400) Si `organizationId` no es un UUID.
   * @throws {ProvisioningIdempotencyKeyRequiredException} (400) Si falta `Idempotency-Key`.
   * @throws Las de `GrantOrganizationCreditsUseCase.execute`.
   *
   * @example
   * ```ts
   * // POST /api/v1/platform/organizations/<organizationId>/credits
   * // x-api-key: <INTERNAL_PLATFORM_API_KEY>
   * // Idempotency-Key: recarga-acme-001
   * ```
   */
  @Post()
  async grant(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Body() dto: GrantOrganizationCreditsDto,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BaseResponse<OrganizationCreditGrantData>> {
    const idempotencyKey = readProvisioningIdempotencyKey(idempotencyKeyHeader);

    const result = await this.grantCredits.execute({
      organizationId,
      dto,
      idempotencyKey,
    });

    const replayed = result.data?.replayed ?? false;
    response.status(replayed ? 200 : 201);
    response.setHeader(PROVISIONING_REPLAYED_HEADER, String(replayed));
    return result;
  }
}
