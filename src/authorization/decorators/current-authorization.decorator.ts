import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { AuthorizationContext } from '../interfaces/authorization-context.interface';

/**
 * Entrega al controller el contexto que `PermissionsGuard` dejó en la petición: usuario, cuenta
 * activa, organización, rol y los alcances concedidos.
 *
 * Sólo tiene valor en endpoints anotados con `@RequirePermission`: en cualquier otro el guard no
 * resolvió nada y esto devuelve `undefined`. Se tipa como `AuthorizationContext` —y no como
 * `AuthorizationContext | undefined`— porque usarlo fuera de un endpoint anotado es un error de
 * programación, no un caso a manejar en tiempo de ejecución.
 *
 * @returns El contexto autorizado de la petición en curso.
 *
 * @example
 * ```ts
 * @Get(':documentId')
 * @RequirePermission(RESOURCE_KEY_ENUM.DOCUMENT, ACTION_KEY_ENUM.READ)
 * getDocument(
 *   @Param('documentId') documentId: string,
 *   @CurrentAuthorization() authorization: AuthorizationContext,
 * ) {
 *   return this.getDocumentUseCase.execute({ documentId, authorization });
 * }
 * ```
 */
export const CurrentAuthorization = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthorizationContext => {
    const request = ctx.switchToHttp().getRequest();
    return request.authorization;
  },
);
