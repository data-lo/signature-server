import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { Match } from '../validators/match.decorator';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Token de corta duración devuelto por /auth/verify-reset-code',
  })
  @IsString()
  @IsNotEmpty()
  resetToken: string;

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
