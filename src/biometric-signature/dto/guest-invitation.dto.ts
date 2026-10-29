import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
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

  /**
   * Opcional: la invitación la identifica el colaborador. Cuando viene (enlace del correo) se
   * compara con el guardado como verificación adicional; cuando no (regreso desde el login de la
   * pantalla pública, que no guarda el correo), basta el colaborador. En ningún caso autoriza
   * nada: el acceso lo da el código enviado al correo GUARDADO.
   */
  @ApiPropertyOptional({
    example: 'ana@correo.mx',
    description: 'Correo invitado (opcional)',
  })
  @IsOptional()
  @IsEmail()
  email?: string;
}

/** Datos de la invitación más el código que llegó al correo. */
export class VerifyGuestAccessCodeDto extends GuestInvitationDto {
  @ApiProperty({ example: '123456', description: 'Código de 6 dígitos' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos' })
  code: string;
}
