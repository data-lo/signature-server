import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * RFC de persona moral (12 caracteres) o física (13): tres o cuatro letras, la fecha AAMMDD y la
 * homoclave. No valida que la fecha exista; eso lo decide el SAT, no el formulario.
 */
export const ORGANIZATION_TAX_ID_PATTERN = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/;

/** Entre 7 y 15 dígitos, sin espacios ni signos: la misma regla que el teléfono personal. */
export const ORGANIZATION_PHONE_PATTERN = /^\d{7,15}$/;

/** Un dominio de correo sin `@` ni protocolo (`acme.com`, `mx.acme.com`). */
export const ORGANIZATION_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/;

/** Largo máximo de la razón social y del nombre de visualización. */
export const ORGANIZATION_NAME_MAX_LENGTH = 255;

/** Largo máximo del domicilio. */
export const ORGANIZATION_ADDRESS_MAX_LENGTH = 500;

/**
 * Recorta los espacios de un texto y deja cualquier otro valor tal cual, para que el validador
 * de tipo lo rechace con su propio mensaje.
 *
 * @param value - Lo que llegó en el body.
 * @returns El texto recortado, o el valor original si no era texto.
 *
 * @example
 * ```ts
 * trimString('  Acme  '); // 'Acme'
 * trimString(42); // 42
 * ```
 */
function trimString(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Recorta un campo que se puede borrar y convierte el texto vacío en `null`.
 *
 * El formulario manda `''` cuando el usuario vacía un campo; guardarlo así dejaría en la base un
 * texto vacío que la pantalla no distingue de "Sin capturar", y que el resto del sistema tendría
 * que tratar como otro caso de ausencia.
 *
 * @param value - Lo que llegó en el body.
 * @returns `null` si llegó vacío o en blanco; el texto recortado si traía algo; el valor original
 *   en cualquier otro caso.
 *
 * @example
 * ```ts
 * emptyToNull('   '); // null
 * emptyToNull(' acme.com '); // 'acme.com'
 * ```
 */
function emptyToNull(value: unknown): unknown {
  const trimmed = trimString(value);
  return trimmed === '' ? null : trimmed;
}

/**
 * Body de `PATCH /organizations/:organizationId`: los datos de "Información de la organización".
 *
 * Los nombres son los mismos que devuelve `GET /organizations/:organizationId`
 * (`OrganizationProfileData`), para que la pantalla mande lo que leyó sin traducir nada. Es a
 * propósito distinto de `UpdateAccountDto`, donde `name` es el nombre de visualización y
 * `organizationName` la razón social.
 *
 * Todo es opcional: sólo se escribe lo que viene. La razón social y el nombre de visualización no
 * se pueden borrar —una organización sin nombre no tiene cómo presentarse—; RFC, teléfono,
 * domicilio y dominio sí, mandándolos en `null` o vacíos.
 */
export class UpdateOrganizationDto {
  @ApiPropertyOptional({
    example: 'Acme',
    description:
      'Nombre de visualización: el corto con el que la organización se presenta en la interfaz',
    maxLength: ORGANIZATION_NAME_MAX_LENGTH,
  })
  @Transform(({ value }) => trimString(value))
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: 'El nombre de visualización debe ser texto' })
  @IsNotEmpty({ message: 'El nombre de visualización es obligatorio' })
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH, {
    message: `El nombre de visualización admite hasta ${ORGANIZATION_NAME_MAX_LENGTH} caracteres`,
  })
  displayName?: string;

  @ApiPropertyOptional({
    example: 'Acme Corp S.A. de C.V.',
    description: 'Razón social o nombre legal completo de la empresa',
    maxLength: ORGANIZATION_NAME_MAX_LENGTH,
  })
  @Transform(({ value }) => trimString(value))
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: 'La razón social debe ser texto' })
  @IsNotEmpty({ message: 'La razón social es obligatoria' })
  @MaxLength(ORGANIZATION_NAME_MAX_LENGTH, {
    message: `La razón social admite hasta ${ORGANIZATION_NAME_MAX_LENGTH} caracteres`,
  })
  name?: string;

  @ApiPropertyOptional({
    example: 'ACM010101AAA',
    description:
      'RFC de la organización, 12 o 13 caracteres. Se guarda en mayúsculas; null o vacío lo borra',
    nullable: true,
  })
  @Transform(({ value }) => {
    const normalized = emptyToNull(value);
    return typeof normalized === 'string'
      ? normalized.toUpperCase()
      : normalized;
  })
  @IsOptional()
  @IsString({ message: 'El RFC debe ser texto' })
  @Matches(ORGANIZATION_TAX_ID_PATTERN, {
    message: 'El RFC no tiene un formato válido (12 o 13 caracteres)',
  })
  taxId?: string | null;

  @ApiPropertyOptional({
    example: '5512345678',
    description:
      'Teléfono de contacto, de 7 a 15 dígitos; null o vacío lo borra',
    nullable: true,
  })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsString({ message: 'El teléfono debe ser texto' })
  @Matches(ORGANIZATION_PHONE_PATTERN, {
    message: 'El teléfono debe tener entre 7 y 15 dígitos',
  })
  phoneNumber?: string | null;

  @ApiPropertyOptional({
    example: 'Av. Reforma 123, CDMX',
    description: 'Domicilio fiscal; null o vacío lo borra',
    nullable: true,
    maxLength: ORGANIZATION_ADDRESS_MAX_LENGTH,
  })
  @Transform(({ value }) => emptyToNull(value))
  @IsOptional()
  @IsString({ message: 'El domicilio debe ser texto' })
  @MaxLength(ORGANIZATION_ADDRESS_MAX_LENGTH, {
    message: `El domicilio admite hasta ${ORGANIZATION_ADDRESS_MAX_LENGTH} caracteres`,
  })
  address?: string | null;

  @ApiPropertyOptional({
    example: 'acme.com',
    description:
      'Dominio de correo permitido para los miembros, sin @. Se guarda en minúsculas; null o vacío lo borra',
    nullable: true,
  })
  @Transform(({ value }) => {
    const normalized = emptyToNull(value);
    return typeof normalized === 'string'
      ? normalized.toLowerCase()
      : normalized;
  })
  @IsOptional()
  @IsString({ message: 'El dominio debe ser texto' })
  @Matches(ORGANIZATION_DOMAIN_PATTERN, {
    message: 'El dominio no tiene un formato válido (por ejemplo, empresa.com)',
  })
  domainAllowed?: string | null;
}
