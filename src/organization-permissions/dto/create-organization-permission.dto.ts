import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateOrganizationPermissionDto {
  @ApiProperty({
    example: 'Aprobar documentos',
    description: 'Nombre del permiso, único dentro de la organización',
  })
  @IsString()
  @IsNotEmpty()
  name: string;
}
