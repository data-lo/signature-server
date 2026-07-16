import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsUUID } from 'class-validator';

export class InviteMemberDto {
  @ApiProperty({
    example: 'nuevo.miembro@empresa.com',
    description: 'Correo del usuario a invitar',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del rol a asignar (ver GET /api/v1/roles)',
    format: 'uuid',
  })
  @IsUUID()
  roleId: string;
}
