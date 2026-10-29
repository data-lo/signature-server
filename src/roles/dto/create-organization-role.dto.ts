import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { STATIC_PERMISSION_KEY_ENUM } from '../static-permission-catalog';

export class CreateOrganizationRoleDto {
  @ApiProperty({
    example: 'Aprobador',
    description: 'Nombre del rol, único dentro de la organización',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    enum: STATIC_PERMISSION_KEY_ENUM,
    isArray: true,
    example: [
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_READ_ORGANIZATION,
      STATIC_PERMISSION_KEY_ENUM.DOCUMENT_APPROVE,
    ],
    description:
      'Claves del catálogo estático de permisos que otorga el rol. Un arreglo vacío es válido.',
  })
  @IsArray()
  @IsEnum(STATIC_PERMISSION_KEY_ENUM, { each: true })
  permissionKeys: STATIC_PERMISSION_KEY_ENUM[];
}
