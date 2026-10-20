import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * Referencia de la invitación que el invitado trae en el enlace de su correo (`collabId`). Sólo la
 * IDENTIFICA: no da acceso a nada. El correo del enlace no se usa: el que cuenta es el guardado en
 * el colaborador.
 */
export class PublicSigningInvitationDto {
  @ApiProperty({ format: 'uuid', description: 'Colaborador de la invitación' })
  @IsUUID()
  collaboratorId: string;
}
