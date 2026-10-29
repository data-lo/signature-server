import { Body, Controller, Headers, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';

import { InternalPlatformAuth } from 'src/auth/decorators/internal-platform-auth.decorator';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { ProvisionProvisionalEnterpriseAccountUseCase } from './applications/provision-provisional-enterprise-account.use-case';
import { ProvisionProvisionalEnterpriseAccountDto } from './dto/provision-provisional-enterprise-account.dto';
import {
  ProvisioningIdempotencyKeyRequiredException,
  ProvisioningReservedFieldsException,
} from './exceptions/platform-provisioning.exceptions';
import { ProvisionedEnterpriseAccountData } from './interfaces/provision-provisional-enterprise-account-response';

/** Header de la respuesta que indica si fue la repetición de un aprovisionamiento ya hecho. */
export const PROVISIONING_REPLAYED_HEADER = 'Idempotent-Replayed';

/** 1 a 255 caracteres ASCII visibles (sin espacios ni controles). */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/**
 * Campos que decide el backend, por sección del body. Si llegan, se rechaza la petición: el
 * `ValidationPipe` global (`whitelist`) los descartaría en silencio y el operador creería haber
 * elegido el plan o los permisos.
 */
export const PROVISIONING_RESERVED_FIELDS: Readonly<
  Record<'root' | 'organization' | 'owner' | 'billing', readonly string[]>
> = {
  root: [
    'planType',
    'permissionIds',
    'permissions',
    'organizationId',
    'createdByAccountId',
  ],
  organization: ['id', 'isActive'],
  owner: ['password', 'lifecycleStatus', 'roles', 'nationalId'],
  billing: [
    'planType',
    'amount',
    'currency',
    'source',
    'billingProfileId',
    'createdByUserId',
  ],
};

/**
 * Operaciones internas de plataforma sobre organizaciones: hoy, aprovisionar una cuenta
 * provisional Enterprise para probar la firma documental por API.
 *
 * - `@InternalPlatformAuth()`: sólo `INTERNAL_PLATFORM_API_KEY` en `x-api-key`; sin JWT, sin
 *   `API_KEY` de servicios, sin membresía.
 * - `@ApiExcludeController()`: no se publica en Swagger (y su módulo tampoco está en el `include`
 *   del documento público de `main.ts`).
 */
@ApiExcludeController()
@InternalPlatformAuth()
@Controller('internal/organizations')
export class InternalOrganizationProvisioningController {
  constructor(
    private readonly provisionAccount: ProvisionProvisionalEnterpriseAccountUseCase,
  ) {}

  /**
   * `POST /api/v1/internal/organizations/provision`: crea usuario provisional, organización,
   * OWNER, perfil Enterprise manual, créditos y API key en una sola transacción.
   *
   * Responde 201 con la llave completa la primera vez, y 200 con `apiKey: null` y el header
   * `Idempotent-Replayed: true` al repetir la misma `Idempotency-Key` con los mismos datos.
   *
   * @param dto - Body validado.
   * @param idempotencyKeyHeader - Header `Idempotency-Key`.
   * @param request - Petición cruda, para rechazar los campos reservados.
   * @param response - Para fijar el estado y el header de repetición.
   * @returns Lo aprovisionado.
   *
   * @throws {ProvisioningReservedFieldsException} (400) Si el body trae `planType`,
   *   `permissionIds` u otro campo que decide el backend.
   * @throws {ProvisioningIdempotencyKeyRequiredException} (400) Si falta `Idempotency-Key`.
   * @throws Las de `ProvisionProvisionalEnterpriseAccountUseCase.execute`.
   *
   * @example
   * ```ts
   * // POST /api/v1/internal/organizations/provision
   * // x-api-key: <INTERNAL_PLATFORM_API_KEY>
   * // Idempotency-Key: prov-acme-001
   * ```
   */
  @Post('provision')
  async provision(
    @Body() dto: ProvisionProvisionalEnterpriseAccountDto,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BaseResponse<ProvisionedEnterpriseAccountData>> {
    assertNoReservedFields(request.body);
    const idempotencyKey = readProvisioningIdempotencyKey(idempotencyKeyHeader);

    const result = await this.provisionAccount.execute({ dto, idempotencyKey });

    const replayed = result.data?.replayed ?? false;
    response.status(replayed ? 200 : 201);
    response.setHeader(PROVISIONING_REPLAYED_HEADER, String(replayed));
    return result;
  }
}

/**
 * Rechaza el body si intenta fijar algo que decide el backend.
 *
 * @param body - Body crudo, antes del `ValidationPipe`.
 * @returns Nada.
 *
 * @throws {ProvisioningReservedFieldsException} (400) Con la lista de campos encontrados
 *   (`billing.planType`, `permissionIds`…).
 *
 * @example
 * ```ts
 * assertNoReservedFields({ planType: 'plus' }); // lanza 400
 * ```
 */
export function assertNoReservedFields(body: unknown): void {
  const found: string[] = [];
  const root = asObject(body);

  for (const [section, fields] of Object.entries(
    PROVISIONING_RESERVED_FIELDS,
  )) {
    const container = section === 'root' ? root : asObject(root?.[section]);
    for (const field of fields) {
      if (container && Object.prototype.hasOwnProperty.call(container, field)) {
        found.push(section === 'root' ? field : `${section}.${field}`);
      }
    }
  }

  if (found.length > 0) {
    throw new ProvisioningReservedFieldsException(found);
  }
}

/**
 * Lee y valida el header `Idempotency-Key`.
 *
 * @param header - Valor crudo del header.
 * @returns La clave, sin espacios alrededor.
 *
 * @throws {ProvisioningIdempotencyKeyRequiredException} (400) Si falta o no tiene de 1 a 255
 *   caracteres ASCII visibles.
 *
 * @example
 * ```ts
 * readProvisioningIdempotencyKey(' prov-acme-001 '); // 'prov-acme-001'
 * ```
 */
export function readProvisioningIdempotencyKey(header: unknown): string {
  const value = typeof header === 'string' ? header.trim() : '';

  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ProvisioningIdempotencyKeyRequiredException();
  }

  return value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
