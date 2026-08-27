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
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * Vocabulario del payload en inglés (pedido por la historia de frontend), distinto de los
 * enums internos del dominio (`SIGNATURE_TYPE_ENUM`/`COLABORATOR_TYPE_ENUM`, en
 * español/minúsculas) — el mapeo entre ambos vive en `CreateDocumentSignatureFlowUseCase`.
 */
export enum PAYLOAD_SIGNATURE_TYPE_ENUM {
  SIMPLE = 'SIMPLE',
  ADVANCED = 'ADVANCED',
}

export enum PAYLOAD_COLABORATOR_TYPE_ENUM {
  SIGNER = 'SIGNER',
  VIEWER = 'VIEWER',
}

/**
 * Espejo de `documentData.signatureType` en vocabulario de dominio. Ya no admite `MIX`: desde la
 * historia "Selección de tipo de firma al crear documentos" un documento tiene UN tipo de firma
 * para todos sus firmantes, así que un documento con "firmas distintas" dejó de ser un estado
 * alcanzable — `CreateDocumentSignatureFlowUseCase` rechaza el payload si este campo contradice a
 * `documentData.signatureType`.
 */
export enum REQUIRES_DIFFERENT_SIGNATURES_ENUM {
  SIMPLE = 'SIMPLE',
  FIEL = 'FIEL',
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

/**
 * Ubicación de una firma sobre una página, en ratios 0-1 relativos al tamaño de esa página (no
 * píxeles absolutos) — ver historia "Ubicación de firmas por usuario". Un mismo firmante puede
 * traer varias instancias de este DTO (una por cada página/zona donde colocó su firma); el
 * frontend siempre manda el arreglo completo, vacío si no colocó ninguna (ver
 * `CollaboratorPayloadDto.signatures`).
 */
export class SignaturePositionDto {
  /** Generado por el cliente (para poder mover/borrar una firma específica en la UI); si no llega, el backend genera uno. */
  @ApiPropertyOptional({ example: 'sig_loc_01' })
  @IsOptional()
  @IsString()
  signatureId?: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  page: number;

  @ApiProperty({ example: 0.65 })
  @IsNumber()
  @Min(0)
  @Max(1)
  xRatio: number;

  @ApiProperty({ example: 0.8 })
  @IsNumber()
  @Min(0)
  @Max(1)
  yRatio: number;

  @ApiProperty({ example: 0.2 })
  @IsNumber()
  @Min(0)
  @Max(1)
  widthRatio: number;

  @ApiProperty({ example: 0.08 })
  @IsNumber()
  @Min(0)
  @Max(1)
  heightRatio: number;
}

export class DocumentDataDto {
  @ApiProperty({ example: 'contrato_prestacion_servicios.pdf' })
  @IsString()
  @IsNotEmpty()
  fileName: string;

  /**
   * Tipo de firma exigido a TODOS los firmantes del documento (historia "Selección de tipo de
   * firma al crear documentos"). Es obligatorio y es la única fuente de verdad del flujo: antes
   * cada colaborador traía el suyo, y una combinación de tipos producía un documento "mixto" que
   * ningún proceso de firma implementa. Al vivir a nivel documento, esa configuración inválida
   * deja de ser expresable en el contrato — no hay que detectarla, no se puede construir.
   */
  @ApiProperty({ enum: PAYLOAD_SIGNATURE_TYPE_ENUM })
  @IsEnum(PAYLOAD_SIGNATURE_TYPE_ENUM)
  signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM;

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
   * Obligatorio SOLO para VIEWER. Los firmantes ya no lo mandan en ningún flujo (historia
   * "Selección de tipo de firma al crear documentos"): en firma simple nunca se pidió, y en firma
   * avanzada el RFC real se extrae del certificado de e.firma al momento de firmar (ver
   * `EfirmaService.extaerRfcDeSubject`) — pedirlo al crear el documento capturaba un dato que
   * nadie contrastaba contra el certificado. `CreateDocumentSignatureFlowUseCase` descarta lo que llegue
   * acá para un SIGNER, así que un cliente viejo no puede reintroducirlo.
   */
  @ApiPropertyOptional({ example: 'PEAJ800101XXX', nullable: true })
  @ValidateIf(
    (c: CollaboratorPayloadDto) =>
      c.collaboratorType === PAYLOAD_COLABORATOR_TYPE_ENUM.VIEWER,
  )
  @IsString()
  @IsNotEmpty()
  rfc?: string | null;

  /**
   * Ubicaciones de firma de este colaborador (ver historia "Ubicación de firmas por usuario").
   * Solo aplica a SIGNER; el backend además refuerza requiresTwoFactorAuth=true cuando el
   * documento es de firma SIMPLE, sin importar lo que llegue en el payload (ver
   * CreateDocumentSignatureFlowUseCase). Un arreglo vacío u
   * omitido es válido: significa que este firmante no tiene ninguna posición asignada, y al
   * firmar se valida su firma sin estampar nada en el PDF (ver finalizeSignedDocument).
   */
  @ApiPropertyOptional({ type: [SignaturePositionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SignaturePositionDto)
  signatures?: SignaturePositionDto[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  requiresTwoFactorAuth?: boolean;

  /**
   * Posición final del colaborador en el flujo de firma (ver historia "Habilitar ordenamiento
   * Drag and Drop para firmantes requeridos"). El frontend la manda siempre, reflejando el orden
   * tras el reordenamiento manual; si no viene, CreateDocumentSignatureFlowUseCase cae de vuelta al orden
   * de aparición en el arreglo (comportamiento previo a esta historia).
   */
  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  orderIndex?: number;
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
   * Redundante con `documentData.signatureType` desde la historia "Selección de tipo de firma al
   * crear documentos": se mantiene por compatibilidad del contrato multipart, pero ya no es una
   * entrada — el backend no lee de acá el tipo de firma, solo verifica que no contradiga a
   * `documentData.signatureType` y rechaza el payload si lo hace (ver CreateDocumentSignatureFlowUseCase).
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
