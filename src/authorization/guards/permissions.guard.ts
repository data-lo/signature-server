import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

import { REQUIRED_PERMISSION_METADATA } from '../constants/permission-metadata.constant';
import { RequiredPermission } from '../interfaces/required-permission.interface';
import { AuthorizationService } from '../services/authorization.service';

/**
 * Guard global de autorización: el tercer eslabón, después de `ApiKeyGuard` y `JwtAuthGuard`.
 *
 * Lee el permiso que el endpoint declaró con `@RequirePermission`, resuelve la cuenta activa de
 * la petición, se lo pasa a `AuthorizationService` y deja el contexto autorizado en
 * `request.authorization` para que lo recoja `@CurrentAuthorization()`.
 *
 * **Un endpoint sin `@RequirePermission` pasa sin tocarse.** No es una puerta abierta por
 * descuido: es lo que permite migrar los controllers de a poco, dejando que cada ruta siga con
 * la validación que ya tenía hasta que se anote. Los endpoints que todavía no están anotados
 * conservan sus propias comprobaciones dentro del caso de uso.
 *
 * **No consulta repositorios de dominio.** No sabe qué es un documento ni un perfil de
 * facturación, y no puede saberlo: si necesitara cargar el recurso para decidir, la decisión ya
 * no sería general y le tocaría a la Policy del recurso.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorizationService: AuthorizationService,
  ) {}

  /**
   * Autoriza la petición en curso.
   *
   * @param context - Contexto de ejecución de Nest.
   * @returns `true` si el endpoint no declara permiso o si el rol de la membresía activa lo
   *   tiene concedido.
   *
   * @throws {ForbiddenException} (403) Si la petición llega sin usuario autenticado, sin cuenta
   *   activa, sin membresía activa, sin rol, o con un rol que no tiene el permiso declarado.
   *
   * @example
   * ```ts
   * // Registrado como guard global; no se invoca a mano.
   * { provide: APP_GUARD, useClass: PermissionsGuard }
   * ```
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      REQUIRED_PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: JwtPayload | undefined = request.user;

    /**
     * 403 y no 401 a propósito. Que un endpoint anotado llegue hasta aquí sin `request.user`
     * significa que alguien lo marcó `@Public()`/`@SkipJwtAuth()` y a la vez le exigió un
     * permiso: una contradicción de configuración, no una sesión caducada. Un 401 mandaría al
     * cliente a renovar un token que sí tenía.
     */
    if (!user?.sub) {
      throw new ForbiddenException(
        'No hay un usuario autenticado en la petición',
      );
    }

    const { organizationId, accountId } = this.resolveActiveAccount(request);

    if (!organizationId && !accountId) {
      throw new ForbiddenException(
        'No se pudo determinar la cuenta activa de la petición',
      );
    }

    request.authorization = await this.authorizationService.authorize({
      userId: user.sub,
      organizationId,
      accountId,
      resource: required.resource,
      action: required.action,
    });

    return true;
  }

  /**
   * De dónde sale la cuenta activa, en orden de prioridad: el `:organizationId` de la ruta, el
   * header `X-Organization-Id` y el header `X-Account-Id`.
   *
   * Los tres conviven hoy en la API y ninguno cubre todos los casos. La ruta sólo existe en los
   * controllers anidados bajo `organizations/:organizationId`; `X-Account-Id` es el único dato
   * disponible en los endpoints que sirven por igual a una cuenta personal y a una organización
   * (documentos, facturación), y el frontend ya lo manda en cada petición junto con
   * `X-Organization-Id` cuando la cuenta activa es una organización.
   *
   * Devolver los dos valores y no uno solo es intencional: `AuthorizationService` usa la
   * organización para localizar la membresía y el `accountId` como respaldo, y quedarse sólo con
   * el primero dejaría sin resolver las cuentas personales, que no tienen organización.
   *
   * @param request - Petición HTTP en curso.
   * @returns La organización y/o la cuenta activa que se hayan podido leer.
   *
   * @example
   * ```ts
   * this.resolveActiveAccount(request); // { organizationId: 'org-1', accountId: 'acc-1' }
   * ```
   */
  private resolveActiveAccount(request: any): {
    organizationId?: string;
    accountId?: string;
  } {
    const organizationId: string | undefined =
      request.params?.organizationId ?? request.headers?.['x-organization-id'];

    const accountId: string | undefined = request.headers?.['x-account-id'];

    return { organizationId, accountId };
  }
}
