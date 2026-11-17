import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
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
    example: 'mi gato duerme en la azotea',
    description:
      'Nueva contraseña. Mínimo 12 caracteres. No puede ser una contraseña común ni fácil de adivinar (por ejemplo, una palabra frecuente con números o símbolos, una secuencia o un patrón del teclado). No se exigen mayúsculas ni símbolos: una frase larga es válida. Si no cumple, la API responde 400 con un mensaje genérico. La valida PasswordPolicyService.',
  })
  @IsString()
  newPassword: string;

  @ApiProperty({
    example: 'mi gato duerme en la azotea',
    description: 'Confirmación de la nueva contraseña',
  })
  @IsString()
  @Match('newPassword', { message: 'Las contraseñas no coinciden' })
  confirmPassword: string;
}
