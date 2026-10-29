import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Tope de los nombres; holgado para nombres compuestos, corto para que no llegue un ensayo. */
export const MAX_CONTACT_NAME_LENGTH = 100;

/** Largo máximo de un correo según RFC 5321. */
export const MAX_CONTACT_EMAIL_LENGTH = 254;

/** Un RFC tiene 12 (persona moral) o 13 caracteres (persona física). */
export const MAX_CONTACT_TAX_ID_LENGTH = 13;

/** E.164 admite hasta 15 dígitos; el resto es margen para el `+` y separadores. */
export const MAX_CONTACT_PHONE_LENGTH = 20;

/**
 * Quita los espacios de los extremos de un valor de texto; cualquier otro valor pasa tal cual
 * para que lo rechace su validador.
 *
 * @param params - El valor crudo que entrega `class-transformer`.
 * @returns El texto recortado, o el valor original si no es texto.
 *
 * @example
 * ```ts
 * @Transform(trimString)
 * firstName: string;
 * ```
 */
export function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Normaliza un campo opcional de texto: recorta, y convierte la cadena vacía en `null` para que
 * "lo borré del formulario" y "nunca lo capturé" se guarden igual.
 *
 * @param params - El valor crudo que entrega `class-transformer`.
 * @returns El texto recortado, `null` si quedó vacío, o el valor original si no es texto.
 *
 * @example
 * ```ts
 * @Transform(trimToNull)
 * phone?: string | null;
 * ```
 */
export function trimToNull({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Cuerpo de `POST /directory/contacts`.
 *
 * No declara `directoryId`, `organizationId`, `createdByAccountId` ni `updatedByAccountId`, y el
 * `ValidationPipe` global (`whitelist: true`) descarta cualquier propiedad que no esté aquí: el
 * directorio y la autoría salen de la cuenta activa, nunca del cliente.
 */
export class CreateDirectoryContactDto {
  @ApiProperty({ example: 'Ana', maxLength: MAX_CONTACT_NAME_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @MaxLength(MAX_CONTACT_NAME_LENGTH)
  firstName: string;

  @ApiProperty({ example: 'García', maxLength: MAX_CONTACT_NAME_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'El apellido es obligatorio' })
  @MaxLength(MAX_CONTACT_NAME_LENGTH)
  lastName: string;

  /**
   * Se recorta aquí para que `IsEmail` no rechace un correo con espacios alrededor; pasarlo a
   * minúsculas lo hace el caso de uso (`normalizeContactEmail`), que es quien compara.
   */
  @ApiProperty({
    example: 'ana@example.com',
    description:
      'Se guarda normalizado (`trim().toLowerCase()`): es único por directorio.',
    maxLength: MAX_CONTACT_EMAIL_LENGTH,
  })
  @Transform(trimString)
  @IsEmail({}, { message: 'El correo no es válido' })
  @MaxLength(MAX_CONTACT_EMAIL_LENGTH)
  email: string;

  @ApiPropertyOptional({
    example: 'GAAA900101XXX',
    description: 'RFC del contacto. Se guarda en mayúsculas.',
    maxLength: MAX_CONTACT_TAX_ID_LENGTH,
    nullable: true,
  })
  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CONTACT_TAX_ID_LENGTH)
  taxId?: string | null;

  @ApiPropertyOptional({
    example: '+526141234567',
    maxLength: MAX_CONTACT_PHONE_LENGTH,
    nullable: true,
  })
  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CONTACT_PHONE_LENGTH)
  phone?: string | null;
}
