import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { RolesService } from '../roles.service';
import { RoleData } from '../interfaces/response/role-response';

/**
 * `GET /api/v1/roles`: catálogo de roles del sistema (ADMIN/MEMBER) que el frontend usa para
 * poblar los selectores de "invitar miembro" y "cambiar rol".
 *
 * La lectura de la tabla vive en `RolesService` —la comparten `findSystemRoleByName` y los
 * checks de permisos—; lo que este caso de uso decide es qué se publica: sólo los roles de
 * sistema, ordenados por nombre, y proyectados a `RoleData` para no filtrar columnas internas
 * de `RoleEntity` hacia la API.
 */
@Injectable()
export class GetSystemRolesUseCase {
  constructor(private readonly rolesService: RolesService) {}

  async execute(): Promise<BaseResponse<RoleData[]>> {
    const roles = await this.rolesService.listSystemRoles();

    return {
      success: true,
      message: 'Roles del sistema obtenidos correctamente',
      data: roles.map((role) => ({
        id: role.id,
        name: role.name,
        isSystemRole: role.isSystemRole,
      })),
    };
  }
}
