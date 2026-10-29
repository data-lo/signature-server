import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from 'src/interfaces/api-response.dto';

import { RolePermissionData } from './permission-response';

export class RoleData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del rol',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({ example: 'ADMIN', description: 'Nombre del rol' })
  name: string;

  @ApiProperty({
    example: true,
    description:
      'Si es un rol del sistema (seed) o uno propio de una organización',
  })
  isSystemRole: boolean;

  @ApiProperty({
    type: [RolePermissionData],
    description:
      'Permisos estáticos que otorga el rol, derivados de role_permissions. Es lo que la pantalla de miembros muestra antes de confirmar una asignación',
  })
  permissions: RolePermissionData[];

  @ApiProperty({
    example: '2026-01-15T10:00:00.000Z',
    description: 'Fecha de creación del rol',
  })
  createdAt: Date;
}

export class RoleListResponse extends BaseResponse<RoleData[]> {
  @ApiProperty({ type: [RoleData], description: 'Roles del sistema' })
  data: RoleData[];
}

export class RoleResponse extends BaseResponse<RoleData> {
  @ApiProperty({ type: RoleData })
  data: RoleData;
}
