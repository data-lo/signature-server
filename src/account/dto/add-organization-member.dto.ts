import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * Alta directa de un miembro en la organización activa.
 *
 * No lleva `organizationId`: la organización sale del header `X-Account-Id` (la membresía del
 * propio llamador). Aceptarla en el body permitiría pedir el alta en una organización ajena, que
 * es justo lo que el aislamiento multi-tenant tiene que impedir.
 *
 * Tampoco lleva `userId`: quien administra conoce el correo de su compañero, no su UUID. Si no
 * hay nadie registrado con ese correo, el camino es la invitación (`POST /organizations/invite`).
 */
export class AddOrganizationMemberDto {
  @ApiProperty({
    example: 'nuevo.miembro@empresa.com',
    description: 'Correo de un usuario YA registrado en la plataforma',
  })
  @IsEmail({}, { message: 'El correo electrónico no es válido' })
  email: string;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description:
      'UUID del rol organizacional que se le asigna (ver GET /api/v1/roles). Los permisos del miembro son los de ese rol',
    format: 'uuid',
  })
  @IsUUID()
  roleId: string;

  @ApiProperty({
    example: 'Gerente de TI',
    description: 'Puesto o cargo dentro de la organización',
    required: false,
  })
  @IsOptional()
  @IsString()
  position?: string;
}
