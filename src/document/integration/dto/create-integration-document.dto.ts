import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
  ValidationOptions,
} from 'class-validator';

import {
  PAYLOAD_SIGNATURE_TYPE_ENUM,
  SignaturePositionDto,
} from '../../dto/create-document-signatures.dto';
import { RFC_FORMAT, normalizeTaxId } from '../../utils/tax-id.util';
import { EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD } from '../docs/api-integration-examples.docs';
import { INTEGRATION_VALIDATION_CODE_ENUM } from '../validation/integration-validation.exception';

/** Largo máximo de nombres y apellidos que se aceptan. */
export const INTEGRATION_NAME_MAX_LENGTH = 100;

/** Largo máximo de un correo (RFC 5321). */
export const INTEGRATION_EMAIL_MAX_LENGTH = 254;

/** Papel de un participante en el documento. */
export enum INTEGRATION_PARTICIPANT_ROLE_ENUM {
  SIGNER = 'SIGNER',
  WITNESS = 'WITNESS',
}

/**
 * Opciones de validación que llevan el código de error de integración en `context`, para que
 * `IntegrationPayloadValidator` responda con ese código en vez de un mensaje genérico.
 *
 * @param code - Código que se reporta si el validador falla.
 * @returns Las opciones para el decorador de class-validator.
 *
 * @example
 * ```ts
 * @IsEmail({}, coded(INTEGRATION_VALIDATION_CODE_ENUM.INVALID_PARTICIPANT_EMAIL))
 * ```
 */
function coded(code: INTEGRATION_VALIDATION_CODE_ENUM): ValidationOptions {
  return { context: { code } };
}

/** Recorta y pasa a minúsculas; cualquier otro valor lo deja para que lo rechace la validación. */
function normalizeEmail({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/** Quita los espacios y pasa a mayúsculas un RFC; cualquier otro valor lo deja para que lo rechace la validación. */
function normalizeTaxIdValue({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? normalizeTaxId(value) : value;
}

/** El mismo `RFC_FORMAT`, como texto para el `pattern` de OpenAPI. */
const RFC_FORMAT_PATTERN = RFC_FORMAT.source;

/** Recorta los espacios de un nombre. */
function trimText({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

const CREATOR = coded(INTEGRATION_VALIDATION_CODE_ENUM.INVALID_CREATOR);
const DOCUMENT = coded(
  INTEGRATION_VALIDATION_CODE_ENUM.INVALID_DOCUMENT_OPTIONS,
);
const ROLE = coded(INTEGRATION_VALIDATION_CODE_ENUM.INVALID_PARTICIPANT_ROLE);
const NAME = coded(INTEGRATION_VALIDATION_CODE_ENUM.INVALID_PARTICIPANT_NAME);
const EMAIL = coded(INTEGRATION_VALIDATION_CODE_ENUM.INVALID_PARTICIPANT_EMAIL);
const ORDER = coded(INTEGRATION_VALIDATION_CODE_ENUM.INVALID_SIGNING_ORDER);
const POSITIONS = coded(
  INTEGRATION_VALIDATION_CODE_ENUM.INVALID_SIGNATURE_POSITION,
);
const TAX_ID = coded(
  INTEGRATION_VALIDATION_CODE_ENUM.INVALID_PARTICIPANT_TAX_ID,
);

/** Quién crea el documento. Se identifica SÓLO por su correo. */
export class IntegrationCreatorDto {
  @ApiProperty({
    example: 'ana@cliente.com',
    description:
      'Correo del creador. Si no existe en la plataforma, se le da de alta como usuario provisional y miembro de la organización.',
  })
  @Transform(normalizeEmail)
  @IsEmail({}, CREATOR)
  @MaxLength(INTEGRATION_EMAIL_MAX_LENGTH, CREATOR)
  email: string;

  @ApiProperty({
    example: 'Ana',
    description:
      'Sólo se usa si el usuario no existe; nunca sobrescribe datos de uno existente.',
  })
  @Transform(trimText)
  @IsString(CREATOR)
  @IsNotEmpty(CREATOR)
  @MaxLength(INTEGRATION_NAME_MAX_LENGTH, CREATOR)
  firstName: string;

  @ApiProperty({ example: 'López' })
  @Transform(trimText)
  @IsString(CREATOR)
  @IsNotEmpty(CREATOR)
  @MaxLength(INTEGRATION_NAME_MAX_LENGTH, CREATOR)
  lastName: string;
}

/** Opciones del documento. El nombre del archivo es el del PDF recibido. */
export class IntegrationDocumentOptionsDto {
  @ApiProperty({ enum: PAYLOAD_SIGNATURE_TYPE_ENUM, example: 'SIMPLE' })
  @IsEnum(PAYLOAD_SIGNATURE_TYPE_ENUM, DOCUMENT)
  signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM;

  @ApiPropertyOptional({
    default: true,
    description:
      'Con `true`, o si se omite, los firmantes firman uno a la vez y cada participante con `role: SIGNER` debe incluir `order`. Con `false`, cualquier firmante pendiente puede firmar en cualquier momento y `order` no es obligatorio ni define el orden de firma. Un `WITNESS` nunca requiere `order`.',
  })
  @IsOptional()
  @IsBoolean(DOCUMENT)
  isSequential?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Por ahora sólo `false`: la aprobación previa no se admite por integración.',
  })
  @IsOptional()
  @IsBoolean(DOCUMENT)
  requiresApproval?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean(DOCUMENT)
  isIndexable?: boolean;
}

/**
 * Un firmante o testigo, invitado por correo.
 *
 * Aquí se valida cada campo por separado. Las reglas entre participantes (correos repetidos, al
 * menos un firmante, posiciones según el rol, orden consecutivo) y las que dependen del PDF
 * (páginas, traslapes) las aplica `IntegrationPayloadValidator`.
 */
export class IntegrationParticipantDto {
  @ApiProperty({
    enum: INTEGRATION_PARTICIPANT_ROLE_ENUM,
    description:
      '`SIGNER` firma el documento: requiere `signaturePositions` y, si el documento es secuencial, `order`. `WITNESS` no requiere `order` ni participa en él, y no admite `signaturePositions`.',
  })
  @IsEnum(INTEGRATION_PARTICIPANT_ROLE_ENUM, ROLE)
  role: INTEGRATION_PARTICIPANT_ROLE_ENUM;

  @ApiProperty({ example: 'Luis', maxLength: INTEGRATION_NAME_MAX_LENGTH })
  @Transform(trimText)
  @IsString(NAME)
  @IsNotEmpty(NAME)
  @MaxLength(INTEGRATION_NAME_MAX_LENGTH, NAME)
  firstName: string;

  @ApiProperty({ example: 'Martínez', maxLength: INTEGRATION_NAME_MAX_LENGTH })
  @Transform(trimText)
  @IsString(NAME)
  @IsNotEmpty(NAME)
  @MaxLength(INTEGRATION_NAME_MAX_LENGTH, NAME)
  lastName: string;

  @ApiProperty({
    example: 'luis@correo.com',
    description: 'Se compara sin espacios y en minúsculas: no puede repetirse.',
  })
  @Transform(normalizeEmail)
  @IsEmail({}, EMAIL)
  @MaxLength(INTEGRATION_EMAIL_MAX_LENGTH, EMAIL)
  email: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    example: 1,
    description:
      'Posición del firmante en el orden de firma: entero que inicia en 1. Obligatorio para cada `SIGNER` si `document.isSequential` es `true` o se omite. Entre los firmantes debe ser único y consecutivo, sin huecos (1, 2, 3…), y es este valor, no la posición en `participants`, lo que define el orden. Un `WITNESS` no lo requiere y no cuenta en la secuencia; con `isSequential: false` tampoco es obligatorio. Si se envía en esos casos no tiene efecto, pero debe ser un entero mayor o igual a 1.',
  })
  @IsOptional()
  @IsInt(ORDER)
  @Min(1, ORDER)
  order?: number;

  @ApiPropertyOptional({
    type: [SignaturePositionDto],
    description:
      'Obligatorio para cada SIGNER (al menos una); prohibido para un WITNESS. Ratios 0-1 de la página.',
  })
  @IsOptional()
  @IsArray(POSITIONS)
  @ValidateNested({ each: true, ...POSITIONS })
  @Type(() => SignaturePositionDto)
  signaturePositions?: SignaturePositionDto[];

  @ApiPropertyOptional({
    description:
      'Código de verificación al firmar. En SIMPLE siempre se exige; en ADVANCED y BIOMETRIC, sólo si es true.',
  })
  @IsOptional()
  @IsBoolean()
  requiresTwoFactorAuth?: boolean;

  @ApiPropertyOptional({
    example: 'LOPA800101AB1',
    minLength: 12,
    maxLength: 13,
    pattern: RFC_FORMAT_PATTERN,
    description: [
      'RFC mexicano del firmante: 13 caracteres para persona física o 12 para persona moral (3 o 4 letras, fecha AAMMDD y homoclave de 3). Se quitan los espacios y se pasa a mayúsculas.',
      'Sólo se admite en un participante con `role: SIGNER` de un documento con `document.signatureType: ADVANCED`; en cualquier otro caso la respuesta es `422 PARTICIPANT_TAX_ID_NOT_ALLOWED`, y con un formato inválido, `422 INVALID_PARTICIPANT_TAX_ID`.',
      'Si viene, el titular del certificado de su e.firma tiene que tener exactamente ese RFC; si no viene, se compara el nombre del colaborador con el del certificado.',
    ].join(' '),
  })
  @IsOptional()
  @Transform(normalizeTaxIdValue)
  @IsString(TAX_ID)
  @Matches(RFC_FORMAT, TAX_ID)
  taxId?: string;
}

/**
 * Contenido del campo multipart `payload`. La presencia, el tamaño y el contenido de
 * `participants` los valida `IntegrationPayloadValidator` con códigos propios.
 */
export class IntegrationDocumentPayloadDto {
  @ApiProperty({ type: IntegrationCreatorDto })
  @IsDefined(CREATOR)
  @ValidateNested(CREATOR)
  @Type(() => IntegrationCreatorDto)
  creator: IntegrationCreatorDto;

  @ApiProperty({ type: IntegrationDocumentOptionsDto })
  @IsDefined(DOCUMENT)
  @ValidateNested(DOCUMENT)
  @Type(() => IntegrationDocumentOptionsDto)
  document: IntegrationDocumentOptionsDto;

  @ApiProperty({ type: [IntegrationParticipantDto] })
  @ValidateNested({ each: true })
  @Type(() => IntegrationParticipantDto)
  participants: IntegrationParticipantDto[];
}

/**
 * `POST /api/v1/integration/documents` (multipart): `file` (PDF binario) y `payload` (JSON con
 * `creator`, `document` y `participants`).
 *
 * `payload` llega crudo (`@Allow`) a propósito: el `ValidationPipe` global respondería un 400
 * genérico sin código ni campo, y el contrato de integración pide `422` con un código estable por
 * regla. Lo valida `IntegrationPayloadValidator`.
 *
 * No existe —ni se acepta— ningún campo de organización, cuenta, usuario o permisos
 * (`organizationId`, `taxId` fuera de un participante, `userId`, `accountId`, `createdBy`,
 * `permissionIds`), ni el PDF en base64 (`documentBase64`): la organización sale de la API key y el
 * creador, de su correo. Si alguno llega, se responde 400 en vez de ignorarlo (ver
 * `assertNoTenantOverrides`). El `taxId` de un participante es otra cosa: el RFC del firmante.
 */
export class CreateIntegrationDocumentDto {
  /**
   * Se declara como el objeto `IntegrationDocumentPayloadDto` y no como `string`: en un cuerpo
   * multipart, OpenAPI manda las propiedades objeto como `application/json`, así que el contrato
   * describe su estructura y Swagger UI lo envía como texto JSON, que es lo que espera el servidor.
   */
  @ApiProperty({
    type: () => IntegrationDocumentPayloadDto,
    description:
      'Campo de texto con un JSON con `creator`, `document` y `participants`.',
    example: EXAMPLE_INTEGRATION_DOCUMENT_PAYLOAD,
  })
  @Allow()
  payload: unknown;

  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'PDF del documento a firmar, como archivo binario.',
  })
  file?: unknown;
}
