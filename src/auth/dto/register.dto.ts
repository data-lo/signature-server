import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';
import { Match } from '../validators/match.decorator';

export class RegisterDto {
  @ApiProperty({ example: 'Juan', description: 'Nombre(s) del usuario' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Pérez López', description: 'Apellidos del usuario' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({
    example: 'juan.perez@empresa.com',
    description: 'Correo electrónico único del usuario',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    example: 'PELJ850101HDFRNN08',
    description: 'CURP del usuario (18 caracteres alfanuméricos)',
  })
  @IsString()
  @IsNotEmpty()
  @Length(18, 18)
  nationalId: string;

  @ApiProperty({
    example: 'PELJ850101ABC',
    description: 'RFC del usuario (12 o 13 caracteres alfanuméricos)',
  })
  @IsString()
  @IsNotEmpty()
  @Length(12, 13)
  rfc: string;

  @ApiProperty({
    example: 'mi gato duerme en la azotea',
    description:
      'Contraseña. Mínimo 12 caracteres. No puede ser una contraseña común ni fácil de adivinar (por ejemplo, una palabra frecuente con números o símbolos, una secuencia o un patrón del teclado). No se exigen mayúsculas ni símbolos: una frase larga es válida. Si no cumple, la API responde 400 con un mensaje genérico. La valida PasswordPolicyService.',
  })
  @IsString()
  password: string;

  @ApiProperty({
    example: 'mi gato duerme en la azotea',
    description: 'Confirmación de la contraseña',
  })
  @IsString()
  @Match('password', { message: 'Las contraseñas no coinciden' })
  confirmPassword: string;

  @ApiProperty({
    example: '0.mF3xk2...token-generado-por-el-widget',
    description:
      'Token de un solo uso que genera el widget de Cloudflare Turnstile en /signup. Se verifica contra Siteverify ANTES de crear o actualizar el pre-registro; si falta, expiró o ya se usó, el registro se rechaza y no se toca la base de datos.',
  })
  @IsString()
  @IsNotEmpty({ message: 'Completa el CAPTCHA para continuar' })
  turnstileToken: string;
}
