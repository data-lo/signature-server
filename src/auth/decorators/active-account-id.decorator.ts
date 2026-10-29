import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Obtiene `X-Account-Id`, el identificador de la cuenta activa seleccionado
 * por el cliente para esta solicitud. La cuenta puede ser personal o una
 * organización.
 *
 * Este decorador sólo extrae el valor del header: no comprueba que esté
 * presente, que tenga un formato válido ni que el usuario autenticado sea
 * miembro de la cuenta.
 */
export const ActiveAccountId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.headers['x-account-id'];
  },
);
