import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type, plainToInstance } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * Vocabulario del payload en inglés (pedido por la historia de frontend), distinto de los
 * enums internos del dominio (`SIGNATURE_TYPE_ENUM`/`COLABORATOR_TYPE_ENUM`, en
 * español/minúsculas) — el mapeo entre ambos vive en `DocumentSignaturesService`.
 */
export enum PAYLOAD_SIGNATURE_TYPE_ENUM {
  SIMPLE = 'SIMPLE',
  ADVANCED = 'ADVANCED',
}

export enum PAYLOAD_COLABORATOR_TYPE_ENUM {
  SIGNER = 'SIGNER',
  VIEWER = 'VIEWER',
}

export enum REQUIRES_DIFFERENT_SIGNATURES_ENUM {
  SIMPLE = 'SIMPLE',
  FIEL = 'FIEL',
  MIX = 'MIX',
}

/**
 * Multipart entrega documentData/collaborators como texto plano (JSON serializado). No basta
 * con JSON.parse: hay que construir instancias reales de la clase destino con
 * `plainToInstance` (mismo patrón que ya usaba `signatureCoordinates` en create-document.dto.ts)
 * — si el `@Transform` deja un objeto plano en vez de una instancia, `ValidationPipe` con
 * `whitelist: true` no reconoce sus propiedades como parte del DTO anidado y las descarta en
 * silencio (bug real encontrado al probar contra un servidor corriendo: `documentData.fileName`
 * llegaba `null` al service pese a venir bien armado en el request).
 */
function parseJson<T>(cls: new () => T) {
  return ({ value }: { value: unknown }): T | T[] | unknown => {
    let parsed: unknown = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        return value;
      }
    }
    return plainToInstance(cls, parsed);
  };
}

export class SignaturePositionDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  page: number;

  @ApiProperty({ example: 150 })
  @IsNumber()
  x: number;

  @ApiProperty({ example: 600 })
  @IsNumber()
  y: number;
}

export class DocumentDataDto {
  @ApiProperty({ example: 'contrato_prestacion_servicios.pdf' })
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Si el documento debe pasar primero por un usuario con permisos de revisión antes de notificar a los firmantes.',
  })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Si los firmantes deben firmar en el orden en que aparecen en `collaborators` (true, comportamiento por defecto) o si cualquiera puede firmar en cualquier momento (false) — ver historia "Notificación por Email para Firma Simple y Vinculación de Cuenta".',
  })
  @IsOptional()
  @IsBoolean()
  isSequential?: boolean;
}

export class CollaboratorPayloadDto {
  @ApiProperty({ enum: PAYLOAD_COLABORATOR_TYPE_ENUM })
  @IsEnum(PAYLOAD_COLABORATOR_TYPE_ENUM)
  collaboratorType: PAYLOAD_COLABORATOR_TYPE_ENUM;

  @ApiProperty({ example: 'Juan' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Pérez' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ example: 'juan.perez@mail.com' })
  @IsEmail()
  email: string;

  /**
   * Obligatorio si collaboratorType es VIEWER, o si es SIGNER con signatureType ADVANCED —
   * ambas condiciones se resuelven sobre el propio objeto (sin depender de ningún default a
   * nivel documento, a diferencia de la versión anterior de este DTO).
   */
  @ApiPropertyOptional({ example: 'PEAJ800101XXX', nullable: true })
  @ValidateIf(
    (c: CollaboratorPayloadDto) =>
      c.collaboratorType === PAYLOAD_COLABORATOR_TYPE_ENUM.VIEWER ||
      c.signatureType === PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED,
  )
  @IsString()
  @IsNotEmpty()
  rfc?: string | null;

  /** Obligatorio (y solo aplica) cuando collaboratorType es SIGNER. */
  @ApiPropertyOptional({ enum: PAYLOAD_SIGNATURE_TYPE_ENUM })
  @ValidateIf(
    (c: CollaboratorPayloadDto) =>
      c.collaboratorType === PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
  )
  @IsEnum(PAYLOAD_SIGNATURE_TYPE_ENUM)
  signatureType?: PAYLOAD_SIGNATURE_TYPE_ENUM;

  /**
   * Sin UI para esto todavía (ver historia) — el frontend inyecta un default. Solo aplica a
   * SIGNER; el backend además refuerza requiresTwoFactorAuth=true para SIMPLE sin importar lo
   * que llegue en el payload (ver DocumentSignaturesService).
   */
  @ApiPropertyOptional({ type: SignaturePositionDto })
  @ValidateIf(
    (c: CollaboratorPayloadDto) =>
      c.collaboratorType === PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
  )
  @ValidateNested()
  @Type(() => SignaturePositionDto)
  signaturePosition?: SignaturePositionDto;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresTwoFactorAuth?: boolean;
}

export class CreateDocumentSignaturesDto {
  @ApiProperty({ type: DocumentDataDto })
  @Transform(parseJson(DocumentDataDto))
  @ValidateNested()
  @Type(() => DocumentDataDto)
  documentData: DocumentDataDto;

  @ApiProperty({ type: [CollaboratorPayloadDto] })
  @Transform(parseJson(CollaboratorPayloadDto))
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CollaboratorPayloadDto)
  collaborators: CollaboratorPayloadDto[];

  /**
   * Calculado por el frontend a partir de los SIGNER del arreglo (ver historia) — el backend lo
   * acepta por compatibilidad de contrato pero no confía en él para nada: recalcula el
   * signatureType real de cada documento a partir de los propios `collaborators`.
   */
  @ApiPropertyOptional({ enum: REQUIRES_DIFFERENT_SIGNATURES_ENUM })
  @IsOptional()
  @IsEnum(REQUIRES_DIFFERENT_SIGNATURES_ENUM)
  requiresDifferentSignatures?: REQUIRES_DIFFERENT_SIGNATURES_ENUM;

  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'PDF del documento a firmar.',
  })
  file?: unknown;
}
