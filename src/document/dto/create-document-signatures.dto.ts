import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type, plainToInstance } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * Vocabulario del payload en inglés (pedido por la historia de frontend), distinto de los
 * enums internos del dominio (`SIGNATURE_TYPE_ENUM`/`COLABORATOR_TYPE_ENUM`) — el mapeo entre ambos vive en `CreateDocumentSignatureFlowUseCase`.
 */
export enum PAYLOAD_SIGNATURE_TYPE_ENUM {
  SIMPLE = 'SIMPLE',
  ADVANCED = 'ADVANCED',
}

export enum PAYLOAD_COLABORATOR_TYPE_ENUM {
  SIGNER = 'SIGNER',
  /** Testigo. Era `VIEWER` hasta la historia "Renombrar rol Espectador a Testigo". */
  WITNESS = 'WITNESS',
}

/**
 * Valor que el payload usaba para el testigo antes de la historia "Renombrar rol Espectador a
 * Testigo". Se sigue aceptando —y se traduce a `WITNESS`— para que una pestaña con el frontend
 * anterior, abierta mientras se despliega, no reciba un 400 al enviar. Se puede retirar cuando
 * ya no quede ningún cliente que lo mande.
 */
const LEGACY_WITNESS_PAYLOAD_VALUE = 'VIEWER';

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
 * traer varias instancias de este DTO (una por cada página/zona donde colocó su firma), y desde
 * la historia "Hacer obligatorias las coordenadas de posición de firma" tiene que traer al menos
 * una (ver `CollaboratorPayloadDto.signatures`).
 *
 * Aquí sólo se valida la forma de cada campo. Lo que depende de otros campos o del PDF —que la
 * caja quepa en la página y que la página exista— lo comprueba
 * `assertSignaturePositionsInsideDocument` en el caso de uso.
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

  /** Mayor que cero: una caja sin ancho no es una posición de firma, aunque esté en rango. */
  @ApiProperty({ example: 0.2 })
  @IsNumber()
  @IsPositive({ message: 'widthRatio debe ser mayor que 0' })
  @Max(1)
  widthRatio: number;

  @ApiProperty({ example: 0.08 })
  @IsNumber()
  @IsPositive({ message: 'heightRatio debe ser mayor que 0' })
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

  /**
   * Usuario que aprobará el documento antes de que salga a firma (historia "Implementar flujo de
   * aprobación previo al proceso de firma"). Es el `users.id` del aprobador, no el id de su
   * membresía: el mismo usuario puede pertenecer a varias organizaciones y quien lo elige en la
   * pantalla lo conoce como persona, no como cuenta.
   *
   * **Obligatorio cuando `requiresApproval` es `true`.** Se valida acá con `ValidateIf` para que
   * el rechazo llegue como un 400 de validación —con el nombre del campo— y no como una excepción
   * de negocio a medio camino del caso de uso. Lo que NO se puede comprobar aquí es si ese
   * usuario existe, si tiene permiso para aprobar y si pertenece a la organización activa: eso
   * necesita base de datos y vive en `CreateDocumentSignatureFlowUseCase`.
   *
   * Con `requiresApproval` en `false` se **rechaza** si llega con valor, en vez de ignorarlo: un
   * cliente que manda aprobador y a la vez dice que no hace falta aprobación se está
   * contradiciendo, y adivinar cuál de las dos cosas quería es justo lo que produce documentos
   * que nadie entiende después. Es el mismo criterio con el que este DTO ya trata
   * `requiresDifferentSignatures` cuando contradice al tipo de firma.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Usuario que aprobará el documento. Obligatorio si `requiresApproval` es true; debe omitirse si es false.',
  })
  @ValidateIf((data: DocumentDataDto) => data.requiresApproval === true)
  @IsUUID()
  @IsNotEmpty()
  reviewerUserId?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Si los firmantes deben firmar en el orden en que aparecen en `collaborators` (true, comportamiento por defecto) o si cualquiera puede firmar en cualquier momento (false) — ver historia "Notificación por Email para Firma Simple y Vinculación de Cuenta".',
  })
  @IsOptional()
  @IsBoolean()
  isSequential?: boolean;

  /**
   * Si el documento entra a Búsqueda Inteligente.
   *
   * Opcional **y con el default en el backend, no en el cliente**: omitirlo da un documento
   * indexable. Que el frontend hoy siempre lo mande no cambia nada — un cliente viejo, una
   * integración o un `curl` obtienen la misma regla, que es lo que impide que "indexable por
   * defecto" dependa de quién llama.
   */
  @ApiPropertyOptional({
    default: true,
    description:
      'Si el documento participa en Búsqueda Inteligente. Si se omite, el backend asigna `true`. Con `false` el documento se crea igual y conserva firma, descarga y auditoría, pero no entra al flujo de indexación.',
  })
  @IsOptional()
  @IsBoolean()
  isIndexable?: boolean;
}

export class CollaboratorPayloadDto {
  @ApiProperty({
    enum: PAYLOAD_COLABORATOR_TYPE_ENUM,
    description:
      '`SIGNER` o `WITNESS`. `VIEWER` se acepta temporalmente como sinónimo obsoleto de `WITNESS`.',
  })
  @Transform(({ value }) =>
    value === LEGACY_WITNESS_PAYLOAD_VALUE
      ? PAYLOAD_COLABORATOR_TYPE_ENUM.WITNESS
      : value,
  )
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
   * Identificador fiscal del colaborador; en México, su RFC (se llamaba `rfc` hasta la historia
   * "Estandarizar campos de colaboradores": el nombre del campo deja de dar por hecho el régimen
   * fiscal, aunque la etiqueta que ve el usuario siga diciendo RFC, que es lo que captura).
   *
   * Opcional incluso para WITNESS (antes era obligatorio para ese tipo; ver historia "Eliminar
   * campo RFC de la sección de Espectadores"). Cuando llega con valor se sigue validando como
   * string — sólo se relajó la obligatoriedad, no el formato. Los firmantes ya no lo mandan en
   * ningún flujo (historia "Selección de tipo de firma al crear documentos"): en firma simple
   * nunca se pidió, y en firma avanzada el dato real se extrae del certificado de e.firma al
   * momento de firmar (ver `EfirmaService.extaerRfcDeSubject`) — pedirlo al crear el documento
   * capturaba un dato que nadie contrastaba contra el certificado.
   * `CreateDocumentSignatureFlowUseCase` descarta lo que llegue acá para un SIGNER, así que un
   * cliente viejo no puede reintroducirlo.
   */
  @ApiPropertyOptional({ example: 'PEAJ800101XXX', nullable: true })
  @ValidateIf(
    (c: CollaboratorPayloadDto) =>
      c.collaboratorType === PAYLOAD_COLABORATOR_TYPE_ENUM.WITNESS &&
      c.taxId !== undefined &&
      c.taxId !== null &&
      c.taxId !== '',
  )
  @IsString()
  taxId?: string | null;

  /**
   * Ubicaciones de firma de este colaborador (ver historia "Ubicación de firmas por usuario").
   * Solo aplica a SIGNER; el backend además refuerza requiresTwoFactorAuth=true cuando el
   * documento es de firma SIMPLE, sin importar lo que llegue en el payload (ver
   * CreateDocumentSignatureFlowUseCase).
   *
   * **Obligatorio y con al menos una posición para cada SIGNER** (historia "Hacer obligatorias
   * las coordenadas de posición de firma"). Antes un arreglo vacío u omitido era válido y el
   * firmante firmaba sin que su firma se estampara en el PDF. Para un VIEWER no se valida: no
   * firma, y lo que mande se ignora al guardar.
   */
  @ApiPropertyOptional({
    type: [SignaturePositionDto],
    description:
      'Obligatorio para SIGNER, con al menos una posición. Se ignora para VIEWER.',
  })
  @ValidateIf(
    (c: CollaboratorPayloadDto) =>
      c.collaboratorType === PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
  )
  // Sin `@IsArray`: `ArrayNotEmpty` ya rechaza cualquier cosa que no sea un arreglo, y con los dos
  // un campo omitido devolvía el mismo mensaje dos veces.
  @ArrayNotEmpty({
    message: 'Es obligatorio indicar la ubicación de la firma de cada firmante',
  })
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
