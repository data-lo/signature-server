import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from 'src/interfaces/api-response.dto';

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
}

export class RoleListResponse extends BaseResponse<RoleData[]> {
  @ApiProperty({ type: [RoleData], description: 'Roles del sistema' })
  data: RoleData[];
}
