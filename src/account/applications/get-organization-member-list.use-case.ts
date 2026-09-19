import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { AccountMemberService } from '../account-member.service';
import { OrganizationMemberData } from '../interfaces/response/account-member-response';

/**
 * `GET /api/v1/organizations/:organizationId/members`: la tabla de gestión de miembros (ver
 * historia [STORY] Gestión de Miembros: Listado, Edición de Roles y Eliminación en
 * Organización).
 *
 * Publica sólo lo que esa pantalla muestra —correo, RFC, rol, estado, fecha de ingreso y los
 * permisos que hereda del rol— en vez de la entidad completa, que traería la contraseña
 * sincronizada de la membresía.
 *
 * El aislamiento multi-tenant no depende del `organizationId` de la URL sino de la comprobación
 * de abajo: quien pregunta tiene que ser miembro activo de ESA organización y tener el permiso
 * ORGANIZATION:READ, así que pasar el identificador de otra organización responde 403.
 */
@Injectable()
export class GetOrganizationMemberListUseCase {
  constructor(private readonly accountMemberService: AccountMemberService) {}

  /**
   * Lista los miembros de una organización para la pantalla de administración.
   *
   * @param callerId - Usuario autenticado que consulta.
   * @param organizationId - Organización cuyos miembros se piden.
   * @param includeInactive - `true` para incluir también las membresías dadas de baja, con su
   * estado real; por defecto sólo se devuelven las activas.
   * @returns Los miembros con rol, estado y permisos derivados del rol.
   *
   * @throws {ForbiddenException} Si el rol del llamador no tiene el permiso `MEMBER.READ` en la
   * organización activa — lo lanza `PermissionsGuard`, antes de llegar aquí.
   *
   * @example
   * ```ts
   * const response = await getOrganizationMemberList.execute(user.sub, 'org-1', true);
   * ```
   */
  async execute(
    callerId: string,
    organizationId: string,
    includeInactive = false,
  ): Promise<BaseResponse<OrganizationMemberData[]>> {
    /**
     * Sin comprobación de permisos aquí: la hace `PermissionsGuard` con el
     * `@RequirePermission(MEMBER, READ)` del controller, que además exige el permiso propio del
     * recurso (`MEMBER.READ`) en vez del genérico `ORGANIZATION.READ`.
     */
    return {
      success: true,
      message: 'Miembros obtenidos correctamente',
      data: await this.accountMemberService.listDetailedByOrganization(
        organizationId,
        { includeInactive },
      ),
    };
  }
}
