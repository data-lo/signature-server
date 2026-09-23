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
 * sincronizada de la membresía. Y sólo a los miembros ACTIVOS: la vista de dados de baja se
 * retiró de la interfaz junto con el parámetro `includeInactive` que la pedía.
 *
 * El aislamiento multi-tenant no depende del `organizationId` de la URL sino del permiso
 * `MEMBER.READ` que exige `PermissionsGuard` sobre la organización activa, así que pasar el
 * identificador de otra organización responde 403.
 */
@Injectable()
export class GetOrganizationMemberListUseCase {
  constructor(private readonly accountMemberService: AccountMemberService) { }

  /**
   * Lista los miembros activos de una organización para la pantalla de administración.
   *
   * @param organizationId - Organización cuyos miembros se piden.
   * @returns Los miembros activos con rol, estado y permisos derivados del rol.
   *
   * @throws {ForbiddenException} Si el rol del llamador no tiene el permiso `MEMBER.READ` en la
   * organización activa — lo lanza `PermissionsGuard`, antes de llegar aquí.
   *
   * @example
   * ```ts
   * const response = await getOrganizationMemberList.execute('org-1');
   * ```
   */
  async execute(
    organizationId: string,
  ): Promise<BaseResponse<OrganizationMemberData[]>> {
    return {
      success: true,
      message: 'Miembros obtenidos correctamente',
      data: await this.accountMemberService.listDetailedByOrganization(
        organizationId,
      ),
    };
  }
}
