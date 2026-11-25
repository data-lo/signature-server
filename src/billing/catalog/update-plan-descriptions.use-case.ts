import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PlanEntity } from './plan.entity';
import { PlanNotFoundException } from './exceptions/plan.exceptions';

/** Lo que responde la actualización: el plan y su lista ya guardada. */
export interface PlanDescriptionsResponse {
  planType: string;
  descriptions: string[];
  updatedAt: Date;
}

/**
 * Reemplaza las descripciones de un plan del catálogo local.
 *
 * Toca SÓLO `descriptions` (y `updated_at`): esta operación no puede cambiar el nombre, el
 * estado, el vínculo con Stripe ni los documentos incluidos del plan.
 *
 * El catálogo público (`GET /payments/services`) lee las descripciones de la base en cada
 * petición, fuera de la caché de Redis, así que el cambio se ve de inmediato.
 */
@Injectable()
export class UpdatePlanDescriptionsUseCase {
  private readonly logger = new Logger(UpdatePlanDescriptionsUseCase.name);

  constructor(
    @InjectRepository(PlanEntity)
    private readonly planRepository: Repository<PlanEntity>,
  ) {}

  /**
   * Guarda la lista completa de descripciones de un plan, en el orden recibido.
   *
   * @param planType - Llave del plan (`plans.plan_type`).
   * @param descriptions - Lista ya validada por `UpdatePlanDescriptionsDto`.
   * @returns El plan con sus descripciones y su fecha de actualización.
   * @throws {PlanNotFoundException} Si no existe un plan con ese `planType`.
   *
   * @example
   * ```ts
   * await useCase.execute('premium', ['Hasta 100 documentos', 'Firma biométrica']);
   * ```
   */
  async execute(
    planType: string,
    descriptions: string[],
  ): Promise<PlanDescriptionsResponse> {
    const result = await this.planRepository.update(
      { planType },
      { descriptions },
    );

    if (!result.affected) {
      throw new PlanNotFoundException(planType);
    }

    const updated = await this.planRepository.findOneOrFail({
      where: { planType },
      select: { planType: true, descriptions: true, updatedAt: true },
    });

    this.logger.log(
      `Descripciones del plan ${planType} actualizadas (${descriptions.length} elementos).`,
    );

    return {
      planType: updated.planType,
      descriptions: updated.descriptions,
      updatedAt: updated.updatedAt,
    };
  }
}
