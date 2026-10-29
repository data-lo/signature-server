import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';

/**
 * Para quién pide el tercero un acceso temporal: el correo del firmante. Sólo LOCALIZA al
 * colaborador dentro del documento; no autoriza nada. La firma exige además el código enviado a
 * ese correo.
 */
export class CreateIntegrationSigningAccessDto {
  @ApiProperty({
    example: 'ana@correo.com',
    description: 'Correo del firmante',
  })
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  @MaxLength(320)
  email: string;
}
