import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsUUID } from 'class-validator';

/**
 * Datos de la invitación que el invitado trae en el enlace de su correo (`collabId` y `email`).
 * Sólo IDENTIFICAN la invitación: no dan acceso a nada.
 */
export class PublicSigningInvitationDto {
  @ApiProperty({ format: 'uuid', description: 'Colaborador de la invitación' })
  @IsUUID()
  collaboratorId: string;

  @ApiProperty({ example: 'ana@correo.mx', description: 'Correo invitado' })
  @IsEmail()
  email: string;
}
