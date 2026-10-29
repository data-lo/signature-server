import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

/** `POST /api/v1/identity-verifications/didit/session` */
export function ApiStartDiditVerification() {
  return applyDecorators(
    ApiOperation({
      summary: 'Iniciar verificación de identidad con Didit',
      description:
        'Crea un intento local en PENDING, abre una sesión con el workflow de Didit y devuelve la URL hospedada, que el frontend usa como contenido del código QR. Si ya existe una sesión abierta y vigente, se devuelve esa misma en lugar de crear otra. Nunca devuelve credenciales del proveedor.',
    }),
    ApiResponse({
      status: 201,
      description: 'Sesión de verificación lista para abrirse.',
    }),
    ApiResponse({
      status: 403,
      description:
        'La verificación está bloqueada o el usuario agotó sus intentos disponibles.',
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
