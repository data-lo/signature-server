import { NotFoundException } from '@nestjs/common';

/**
 * El `planType` de la ruta no corresponde a ninguna fila de `plans`.
 *
 * 404 y no 400: la petición está bien formada, lo que no existe es el recurso.
 *
 * @example
 * ```ts
 * throw new PlanNotFoundException('enterprise');
 * ```
 */
export class PlanNotFoundException extends NotFoundException {
  constructor(planType: string) {
    super(`No existe el plan '${planType}'.`);
  }
}
