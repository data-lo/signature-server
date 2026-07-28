import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Extrae el header X-Account-Id (la cuenta/organización activa elegida en
 * el switcher del frontend). Solo extrae el valor crudo — la validación de
 * que exista y de que el usuario autenticado pertenezca a esa cuenta vive en
 * el servicio que lo consume (mismo patrón que AccountMemberService.assertIsOwner),
 * no aquí ni en un guard.
 */
export const ActiveAccountId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.headers['x-account-id'];
  },
);
