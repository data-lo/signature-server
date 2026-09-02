import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { Match } from 'src/auth/validators/match.decorator';

/**
 * Cambio de contraseña con sesión iniciada. A diferencia de `ResetPasswordDto` —el del flujo de
 * "olvidé mi contraseña", que acredita a la persona con un token de un solo uso— acá quien
 * acredita es la contraseña actual: el JWT prueba quién es, no que siga siendo quien dejó la
 * sesión abierta.
 */
export class ChangeMyPasswordDto {
  @ApiProperty({
    example: 'miContrasenaActual',
    description: 'Contraseña vigente del usuario',
  })
  @IsString()
  @IsNotEmpty({ message: 'Ingresa tu contraseña actual' })
  currentPassword: string;

  @ApiProperty({
    example: 'supersecret123',
    description: 'Nueva contraseña (mínimo 8 caracteres)',
  })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  newPassword: string;

  @ApiProperty({
    example: 'supersecret123',
    description: 'Confirmación de la nueva contraseña',
  })
  @IsString()
  @Match('newPassword', { message: 'Las contraseñas no coinciden' })
  confirmPassword: string;
}
