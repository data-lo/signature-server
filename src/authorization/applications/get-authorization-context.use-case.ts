import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { isStaticCatalogPermission } from 'src/roles/permission-catalog.util';
import { RolesService } from 'src/roles/roles.service';
import { STATIC_PERMISSION_KEY_ENUM } from 'src/roles/static-permission-catalog';

import { AuthorizationContextData } from '../interfaces/response/authorization-context-response';

/**
 * `GET /api/v1/authorization/context`: qué puede hacer el usuario autenticado en la cuenta que
 * tiene activa.
 *
 * Existe para que el frontend pinte UNA vez, en el render inicial del dashboard, un menú y unas
 * acciones que correspondan con lo que el backend va a aceptar. **No es una puerta**: cada
 * endpoint vuelve a validar su propio permiso, y ocultar un botón no protege nada. Que esto
 * responda 200 no autoriza ninguna operación.
 *
 * Devuelve SÓLO las claves del catálogo estático. La base conserva además la rejilla CRUD
 * heredada del seed anterior (`USER.READ`, `ORGANIZATION.CREATE`, `DOCUMENT.DELETE`…), que no
 * describe capacidades de negocio y que el frontend no sabría interpretar: publicarla obligaría a
 * su unión de tipos a crecer con claves que nadie usa. Ver `isStaticCatalogPermission`.
 */
@Injectable()
export class GetAuthorizationContextUseCase {
  constructor(
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
    private readonly rolesService: RolesService,
  ) {}

  /**
   * Resuelve el contexto efectivo de la cuenta activa.
   *
   * @param userId - Usuario autenticado (`JwtPayload.sub`).
   * @param activeAccountId - Cuenta activa que el cliente declara, en `X-Active-Account-Id`.
   * @returns Cuenta, tipo, organización, rol (identificador y nombre) y permisos efectivos.
   *
   * @throws {BadRequestException} (400) Si la petición no declara cuenta activa.
   * @throws {ForbiddenException} (403) Si esa cuenta no existe, no es del usuario autenticado o
   *   su membresía está dada de baja.
   *
   * @example
   * ```ts
   * const context = await getAuthorizationContext.execute('user-1', 'account-1');
   * context.data.permissions; // ['ORGANIZATION.READ', 'DOCUMENT.CREATE', …]
   * ```
   */
  async execute(
    userId: string,
    activeAccountId: string | undefined,
  ): Promise<BaseResponse<AuthorizationContextData>> {
    if (!activeAccountId) {
      throw new BadRequestException(
        'Falta el header X-Active-Account-Id de la cuenta activa',
      );
    }

    /**
     * La pertenencia se comprueba en el propio `where`, no después: buscar por `id` y filtrar en
     * memoria haría que una cuenta ajena y una inexistente recorrieran caminos distintos, y de
     * ahí sale el 404 que confirma qué identificadores existen.
     */
    const membership = await this.accountRepository.findOne({
      where: { id: activeAccountId, userId, isActive: true },
      /**
       * El rol se carga para publicar su NOMBRE junto al identificador. El cliente no tiene con
       * qué traducir un UUID de rol, y hay decisiones suyas que dependen de cuál es —comprobar
       * que quien acaba de crear una organización quedó como su propietario antes de mandarlo a
       * contratar un plan, por ejemplo—.
       */
      relations: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('No tienes acceso a esta cuenta');
    }

    return {
      success: true,
      message: 'Contexto de autorización obtenido correctamente',
      data: {
        accountId: membership.id,
        accountType: membership.accountType,
        organizationId: membership.organizationId,
        roleId: membership.roleId,
        roleName: membership.role?.name ?? null,
        permissions: await this.resolveEffectivePermissions(membership.roleId),
      },
    };
  }

  /**
   * Claves del catálogo estático que otorga un rol.
   *
   * Una membresía sin rol devuelve la lista vacía en vez de fallar: es una situación prevista
   * (`accounts.role_id` es nullable) y significa exactamente "todavía no puede hacer nada", que
   * es un menú vacío y no un error de pantalla.
   *
   * @param roleId - Rol de la membresía activa.
   * @returns Las claves del catálogo, en el orden en que `listPermissionsByRoleIds` las ordena.
   *
   * @throws {QueryFailedError} Si la consulta contra Postgres falla.
   *
   * @example
   * ```ts
   * await this.resolveEffectivePermissions('role-1'); // ['BILLING.READ', 'MEMBER.READ', …]
   * ```
   */
  private async resolveEffectivePermissions(
    roleId: string | null,
  ): Promise<STATIC_PERMISSION_KEY_ENUM[]> {
    if (!roleId) return [];

    const byRole = await this.rolesService.listPermissionsByRoleIds([roleId]);

    return (byRole.get(roleId) ?? [])
      .map((permission) => permission.key)
      .filter(isStaticCatalogPermission) as STATIC_PERMISSION_KEY_ENUM[];
  }
}
