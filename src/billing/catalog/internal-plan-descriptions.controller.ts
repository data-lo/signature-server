import { Body, Controller, Param, Patch } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { InternalPlatformAuth } from 'src/auth/decorators/internal-platform-auth.decorator';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UpdatePlanDescriptionsDto } from './dto/update-plan-descriptions.dto';
import {
  PlanDescriptionsResponse,
  UpdatePlanDescriptionsUseCase,
} from './update-plan-descriptions.use-case';

/**
 * Administración interna de las descripciones de los planes.
 *
 * - `@InternalPlatformAuth()`: sólo `INTERNAL_PLATFORM_API_KEY` en `x-api-key`. Los planes son el
 *   catálogo de TODA la plataforma; ningún rol de una organización cliente (ni su OWNER) debe
 *   poder reescribir lo que ven las demás.
 * - `@ApiExcludeController()`: no se publica en Swagger.
 */
@ApiExcludeController()
@InternalPlatformAuth()
@Controller('platform/plans/:planType/descriptions')
export class InternalPlanDescriptionsController {
  constructor(
    private readonly updatePlanDescriptions: UpdatePlanDescriptionsUseCase,
  ) {}

  /**
   * `PATCH /api/v1/platform/plans/:planType/descriptions`: reemplaza la lista de descripciones.
   *
   * @param planType - Llave del plan (`premium`, `plus`, `free`…).
   * @param dto - Body validado: `{ descriptions: string[] }`.
   * @returns El plan con sus descripciones guardadas.
   * @throws {BadRequestException} (400) Si `descriptions` no cumple las reglas del DTO.
   * @throws {UnauthorizedException} (401) Sin `INTERNAL_PLATFORM_API_KEY` válida.
   * @throws {PlanNotFoundException} (404) Si el plan no existe.
   *
   * @example
   * ```ts
   * // PATCH /api/v1/platform/plans/premium/descriptions
   * // x-api-key: <INTERNAL_PLATFORM_API_KEY>
   * // { "descriptions": ["Hasta 10 documentos", "Firma electrónica"] }
   * ```
   */
  @Patch()
  async update(
    @Param('planType') planType: string,
    @Body() dto: UpdatePlanDescriptionsDto,
  ): Promise<BaseResponse<PlanDescriptionsResponse>> {
    return {
      success: true,
      message: 'Descripciones del plan actualizadas correctamente',
      data: await this.updatePlanDescriptions.execute(
        planType,
        dto.descriptions,
      ),
    };
  }
}
