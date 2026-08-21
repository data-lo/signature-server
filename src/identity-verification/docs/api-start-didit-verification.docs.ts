import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/identity-verifications/didit/session` */
export function ApiStartDiditVerification() {
  return applyDecorators(
    ApiOperation({
      summary: 'Iniciar verificación de identidad con Didit',
      description:
        'Crea un intento local en PENDING, abre una sesión con el workflow de Didit y devuelve la URL hospedada para abrirla en la misma PC o convertirla en QR. Si ya existe una sesión abierta y vigente, se devuelve esa misma en lugar de crear otra. Nunca devuelve credenciales del proveedor.',
    }),
    ApiResponse({
      status: 201,
      description: 'Sesión de verificación lista para abrirse.',
    }),
    ApiResponse({
      status: 409,
      description: 'El usuario ya tiene una identidad verificada.',
    }),
    ApiResponse({
      status: 502,
      description: 'Didit no respondió o devolvió una respuesta inválida.',
    }),
  );
}
