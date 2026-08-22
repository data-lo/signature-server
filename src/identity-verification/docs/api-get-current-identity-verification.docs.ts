import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `GET /api/v1/identity-verifications/current` */
export function ApiGetCurrentIdentityVerification() {
  return applyDecorators(
    ApiOperation({
      summary: 'Consultar el estado de verificación de identidad',
      description:
        'Devuelve el último intento del usuario junto con `signingCredentialStatus`, el estado global que habilita o bloquea los pasos siguientes, y la bandera derivada `signingCredentialConfigured`. `verification.checks` resume qué comprobó el proveedor (documento, coincidencia facial y prueba de vida) sin exponer datos personales del veredicto. `verification: null` significa que nunca inició una verificación.',
    }),
    ApiResponse({
      status: 200,
      description: 'Estado actual de la identidad y de la credencial de firma.',
    }),
  );
}
