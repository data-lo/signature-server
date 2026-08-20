import { applyDecorators } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

/** `GET /stripe/plans` — catálogo de planes disponibles. */
export function ApiGetPlans() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listar planes disponibles',
      description:
        'Devuelve el id interno y el price_id de Stripe de cada plan; la copia visual vive en el frontend.',
    }),
  );
}
