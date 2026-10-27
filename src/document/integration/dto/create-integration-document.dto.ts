import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  parseJson,
  PAYLOAD_SIGNATURE_TYPE_ENUM,
  SignaturePositionDto,
} from '../../dto/create-document-signatures.dto';

/** Largo máximo de nombres y apellidos que se aceptan. */
const NAME_MAX_LENGTH = 100;

/** Tope de participantes por documento, para acotar el tamaño del payload. */
export const MAX_INTEGRATION_PARTICIPANTS = 50;

/** Papel de un participante en el documento. */
export enum INTEGRATION_PARTICIPANT_ROLE_ENUM {
  SIGNER = 'SIGNER',
  WITNESS = 'WITNESS',
}

/** Quién crea el documento. Se identifica SÓLO por su correo. */
export class IntegrationCreatorDto {
  @ApiProperty({
    example: 'ana@cliente.com',
    description:
      'Correo del creador. Si no existe en la plataforma, se le da de alta como usuario provisional y miembro de la organización.',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({
    example: 'Ana',
    description:
      'Sólo se usa si el usuario no existe; nunca sobrescribe datos de uno existente.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  firstName: string;

  @ApiProperty({ example: 'López' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  lastName: string;
}

/** Opciones del documento. El nombre del archivo es el del PDF recibido. */
export class IntegrationDocumentOptionsDto {
  @ApiProperty({ enum: PAYLOAD_SIGNATURE_TYPE_ENUM, example: 'SIMPLE' })
  @IsEnum(PAYLOAD_SIGNATURE_TYPE_ENUM)
  signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isSequential?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Por ahora sólo `false`: la aprobación previa no se admite por integración.',
  })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isIndexable?: boolean;
}

/** Un firmante o testigo, invitado por correo. */
export class IntegrationParticipantDto {
  @ApiProperty({ enum: INTEGRATION_PARTICIPANT_ROLE_ENUM })
  @IsEnum(INTEGRATION_PARTICIPANT_ROLE_ENUM)
  role: INTEGRATION_PARTICIPANT_ROLE_ENUM;

  @ApiProperty({ example: 'Luis' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  firstName: string;

  @ApiProperty({ example: 'Martínez' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  lastName: string;

  @ApiProperty({ example: 'luis@correo.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Posición en el orden de firma, desde 1. Si todos la traen, se firma en ese orden; si no, en el del arreglo.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  order?: number;

  @ApiPropertyOptional({
    type: [SignaturePositionDto],
    description:
      'Obligatorio para cada SIGNER: dónde va su firma, en ratios 0-1 de la página.',
  })
  @ValidateIf(
    (participant: IntegrationParticipantDto) =>
      participant.role === INTEGRATION_PARTICIPANT_ROLE_ENUM.SIGNER ||
      participant.signaturePositions !== undefined,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SignaturePositionDto)
  signaturePositions?: SignaturePositionDto[];

  @ApiPropertyOptional({
    description:
      'Código de verificación al firmar. En SIMPLE siempre se exige; en ADVANCED y BIOMETRIC, sólo si es true.',
  })
  @IsOptional()
  @IsBoolean()
  requiresTwoFactorAuth?: boolean;
}

/** Contenido del campo multipart `payload`. */
export class IntegrationDocumentPayloadDto {
  @ApiProperty({ type: IntegrationCreatorDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => IntegrationCreatorDto)
  creator: IntegrationCreatorDto;

  @ApiProperty({ type: IntegrationDocumentOptionsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => IntegrationDocumentOptionsDto)
  document: IntegrationDocumentOptionsDto;

  @ApiProperty({ type: [IntegrationParticipantDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INTEGRATION_PARTICIPANTS)
  @ValidateNested({ each: true })
  @Type(() => IntegrationParticipantDto)
  participants: IntegrationParticipantDto[];
}

/**
 * `POST /api/v1/integration/documents` (multipart): `file` (PDF binario) y `payload` (JSON con
 * `creator`, `document` y `participants`).
 *
 * No existe —ni se acepta— ningún campo de organización, cuenta, usuario o permisos
 * (`organizationId`, `taxId`, `userId`, `accountId`, `createdBy`, `permissionIds`), ni el PDF en
 * base64 (`documentBase64`): la organización sale de la API key y el creador, de su correo. Si
 * alguno llega, se responde 400 en vez de ignorarlo (ver `assertNoTenantOverrides`).
 */
export class CreateIntegrationDocumentDto {
  @ApiProperty({
    type: 'string',
    description:
      'JSON con `creator`, `document` y `participants` (ver `IntegrationDocumentPayloadDto`).',
    example: JSON.stringify({
      creator: {
        email: 'ana@cliente.com',
        firstName: 'Ana',
        lastName: 'López',
      },
      document: {
        signatureType: 'SIMPLE',
        isSequential: true,
        requiresApproval: false,
        isIndexable: true,
      },
      participants: [
        {
          role: 'SIGNER',
          firstName: 'Luis',
          lastName: 'Martínez',
          email: 'luis@correo.com',
          order: 1,
          signaturePositions: [
            {
              page: 1,
              xRatio: 0.65,
              yRatio: 0.8,
              widthRatio: 0.18,
              heightRatio: 0.06,
            },
          ],
        },
      ],
    }),
  })
  @Transform(parseJson(IntegrationDocumentPayloadDto))
  @IsDefined()
  @ValidateNested()
  @Type(() => IntegrationDocumentPayloadDto)
  payload: IntegrationDocumentPayloadDto;

  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'PDF del documento a firmar, como archivo binario.',
  })
  file?: unknown;
}
