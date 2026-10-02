import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

/**
 * Datos de la invitación que el invitado trae en el enlace de su correo (`collabId` y `email`).
 * Por sí solos NO dan acceso: sólo identifican a qué invitación se le manda el código.
 */
export class GuestInvitationDto {
  @ApiProperty({ format: 'uuid', description: 'Colaborador de la invitación' })
  @IsUUID()
  collaboratorId: string;

  @ApiProperty({ example: 'ana@correo.mx', description: 'Correo invitado' })
  @IsEmail()
  email: string;
}

/** Datos de la invitación más el código que llegó al correo. */
export class VerifyGuestAccessCodeDto extends GuestInvitationDto {
  @ApiProperty({ example: '123456', description: 'Código de 6 dígitos' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos' })
  code: string;
}
