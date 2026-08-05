import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class AssignMemberPermissionsDto {
  @ApiProperty({
    example: ['a1b2c3d4-e5f6-7890-abcd-ef1234567890'],
    description:
      'UUIDs de los permisos del catálogo de la organización a asignar a este miembro. Un arreglo vacío desasigna todos los permisos actuales.',
    type: [String],
  })
  @IsArray()
  @IsUUID('4', { each: true })
  permissionIds: string[];
}
