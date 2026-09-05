import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

/**
 * Corrección de los datos de un registro que todavía no verifica su correo.
 *
 * Identifica el pre-registro con `currentEmail` —el correo tal como se tecleó, aunque tenga el
 * error— y lo autoriza con `password`, el único secreto que existe antes de verificar. Sin ese
 * requisito, conocer el CURP bastaría para redirigir el registro de otra persona a un correo propio,
 * que es justo lo que evita el "Caso A" de `UserService.createFromSignup`.
 *
 * Todos los datos nuevos son opcionales: se manda sólo lo que se corrige. La contraseña no se cambia
 * acá porque es la credencial que autoriza la operación; para eso está el flujo de recuperación.
 */
export class UpdatePreRegistrationDto {
  @ApiProperty({
    example: 'juan.perez@empresa.con',
    description:
      'Correo con el que se hizo el registro pendiente, incluso si es el que tiene el error',
  })
  @IsEmail()
  @IsNotEmpty()
  currentEmail: string;

  @ApiProperty({
    example: 'supersecret123',
    description:
      'Contraseña elegida durante el registro; autoriza la corrección',
  })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiPropertyOptional({
    example: 'juan.perez@empresa.com',
    description:
      'Correo corregido. Si cambia, se envía un código nuevo a esta dirección',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'Juan' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Pérez López' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  lastName?: string;

  @ApiPropertyOptional({
    example: 'PELJ850101HDFRNN08',
    description: 'CURP corregido (18 caracteres)',
  })
  @IsOptional()
  @IsString()
  @Length(18, 18)
  nationalId?: string;

  @ApiPropertyOptional({
    example: 'PELJ850101ABC',
    description: 'RFC corregido (12 o 13 caracteres)',
  })
  @IsOptional()
  @IsString()
  @Length(12, 13)
  rfc?: string;
}
