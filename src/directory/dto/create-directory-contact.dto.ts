import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Tope de los nombres; holgado para nombres compuestos, corto para que no llegue un ensayo. */
export const MAX_CONTACT_NAME_LENGTH = 100;

/** Largo máximo de un correo según RFC 5321. */
export const MAX_CONTACT_EMAIL_LENGTH = 254;

/**
 * Quita los espacios de los extremos de un valor de texto; cualquier otro valor pasa tal cual para
 * que lo rechace su validador.
 *
 * @param params - El valor crudo que entrega `class-transformer`.
 * @returns El texto recortado, o el valor original si no es texto.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * trimString({ value: '  Ana ' }); // 'Ana'
 * ```
 */
export function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Cuerpo de `POST /directory-contacts`: sólo nombre, apellido y correo.
 *
 * No declara `accountId`, `organizationId` ni `directoryId`, y el `ValidationPipe` global
 * (`whitelist: true`) descarta cualquier propiedad que no esté aquí: el directorio sale de la
 * cuenta activa validada, nunca del cliente.
 */
export class CreateDirectoryContactDto {
  @ApiProperty({ example: 'Ana', maxLength: MAX_CONTACT_NAME_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @MaxLength(MAX_CONTACT_NAME_LENGTH)
  firstName: string;

  @ApiProperty({ example: 'García López', maxLength: MAX_CONTACT_NAME_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'El apellido es obligatorio' })
  @MaxLength(MAX_CONTACT_NAME_LENGTH)
  lastName: string;

  @ApiProperty({
    example: 'ana.garcia@example.com',
    maxLength: MAX_CONTACT_EMAIL_LENGTH,
    description: 'Se guarda recortado y en minúsculas.',
  })
  @Transform(trimString)
  @IsEmail({}, { message: 'El correo no es válido' })
  @MaxLength(MAX_CONTACT_EMAIL_LENGTH)
  email: string;
}
