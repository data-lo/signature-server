import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';

/** `GET /api/v1/users/check-rfc` — si un RFC ya pertenece a un usuario registrado. */
export function ApiCheckRfcAvailability() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar si un RFC ya pertenece a un usuario registrado',
      description:
        'Público (sin JWT) — usado desde /join y /signup en signature-app para bifurcar el flujo de invitación a organización: RFC existente → unirse con la cuenta actual; RFC nuevo → registrarse.',
    }),
    ApiQuery({ name: 'rfc', required: true, type: String }),
    ApiResponse({
      status: 200,
      description: 'Disponibilidad del RFC consultada correctamente',
    }),
  );
}
