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

/** Recorta y pasa a mayúsculas un RFC; cualquier otro valor lo deja para que lo rechace la validación. */
function normalizeRfc({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

/** Forma de un RFC de persona física (13) o moral (12). */
export const RFC_FORMAT = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/;

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
const RFC = coded(INTEGRATION_VALIDATION_CODE_ENUM.INVALID_PARTICIPANT_RFC);

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
      'Con `true` (el valor por omisión) los firmantes firman por `order`, que debe ser único y consecutivo desde 1.',
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
  @ApiProperty({ enum: INTEGRATION_PARTICIPANT_ROLE_ENUM })
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
    example: 1,
    description:
      'Posición del firmante en el orden de firma, desde 1. Obligatorio para cada SIGNER si `document.isSequential` es `true`; único y consecutivo.',
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
    description:
      'RFC del firmante. Sólo para un SIGNER de un documento `ADVANCED`: si viene, el titular del certificado de su e.firma tiene que tener exactamente ese RFC; si no viene, se compara el nombre del colaborador con el del certificado.',
  })
  @IsOptional()
  @Transform(normalizeRfc)
  @IsString(RFC)
  @Matches(RFC_FORMAT, RFC)
  rfc?: string;
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
 * (`organizationId`, `taxId`, `userId`, `accountId`, `createdBy`, `permissionIds`), ni el PDF en
 * base64 (`documentBase64`): la organización sale de la API key y el creador, de su correo. Si
 * alguno llega, se responde 400 en vez de ignorarlo (ver `assertNoTenantOverrides`).
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
