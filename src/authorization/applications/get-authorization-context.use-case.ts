import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { isStaticCatalogPermission } from 'src/roles/permission-catalog.util';
import { PERSONAL_ACCOUNT_PERMISSION_KEYS } from 'src/roles/personal-account-permissions';
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
 * **Una cuenta PERSONAL no responde con los permisos de su rol.** Nace con el rol de sistema
 * OWNER, que trae el catálogo entero, así que publicarlos tal cual le pintaría un menú con
 * "Administrar miembros" y "Roles y permisos" de una organización que no tiene. Lo que se
 * publica es el recorte del catálogo que le corresponde por ser personal (ver
 * `personal-account-permissions.ts`), el MISMO que después aplica `AuthorizationService` al
 * autorizar cada endpoint: el menú y la API dicen lo mismo porque leen lo mismo.
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
   * @returns Cuenta, tipo, organización, rol y permisos efectivos.
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
        permissions: await this.resolveEffectivePermissions(membership),
      },
    };
  }

  /**
   * Claves del catálogo estático que la membresía activa tiene concedidas.
   *
   * Una cuenta PERSONAL no consulta la base: sus permisos son los del catálogo que no exigen una
   * organización, siempre los mismos, y no dependen ni de su rol ni de que lo tenga. Eso la deja
   * con Planes, Suscripciones y sus documentos, y sin nada de administración.
   *
   * Una membresía de ORGANIZATION sin rol devuelve la lista vacía en vez de fallar: es una
   * situación prevista (`accounts.role_id` es nullable) y significa exactamente "todavía no
   * puede hacer nada", que es un menú vacío y no un error de pantalla.
   *
   * @param membership - Membresía activa del usuario.
   * @returns Las claves del catálogo, en el orden en que `listPermissionsByRoleIds` las ordena,
   *   o en el del catálogo si la cuenta es personal.
   *
   * @throws {QueryFailedError} Si la consulta contra Postgres falla.
   *
   * @example
   * ```ts
   * await this.resolveEffectivePermissions(personalAccount);
   * // ['BILLING.READ', 'BILLING.MANAGE', 'DOCUMENT.CREATE', …]
   * ```
   */
  private async resolveEffectivePermissions(
    membership: AccountEntity,
  ): Promise<STATIC_PERMISSION_KEY_ENUM[]> {
    if (membership.accountType === ACCOUNT_TYPE_ENUM.PERSONAL) {
      return [...PERSONAL_ACCOUNT_PERMISSION_KEYS];
    }

    if (!membership.roleId) return [];

    const byRole = await this.rolesService.listPermissionsByRoleIds([
      membership.roleId,
    ]);

    return (byRole.get(membership.roleId) ?? [])
      .map((permission) => permission.key)
      .filter(isStaticCatalogPermission) as STATIC_PERMISSION_KEY_ENUM[];
  }
}
