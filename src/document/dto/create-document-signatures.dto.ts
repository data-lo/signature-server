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
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Vocabulario del payload en inglés (pedido por la historia de frontend), distinto de los
 * enums internos del dominio (`SIGNATURE_TYPE_ENUM`/`COLABORATOR_TYPE_ENUM`) — el mapeo entre ambos vive en `CreateDocumentSignatureFlowUseCase`.
 */
export enum PAYLOAD_SIGNATURE_TYPE_ENUM {
  SIMPLE = 'SIMPLE',
  ADVANCED = 'ADVANCED',
  /**
   * Cada firmante se identifica con Didit al firmar (historia "Mostrar firma biométrica en las
   * opciones de tipo de firma"). Exige `graphSignatureBiometrics` en el plan de la cuenta activa.
   */
  BIOMETRIC = 'BIOMETRIC',
}

export enum PAYLOAD_COLABORATOR_TYPE_ENUM {
  SIGNER = 'SIGNER',
  /** Testigo. Era `VIEWER` hasta la historia "Renombrar rol Espectador a Testigo". */
  WITNESS = 'WITNESS',
}

/**
 * De dónde sale la identidad de un colaborador (historia "Enviar colaboradores desde Directorio
 * mediante usuario vinculado al crear un documento").
 *
 * - `MANUAL`: el cliente captura nombre, apellido y correo, y puede pedir con `addToDirectory`
 *   que el contacto quede en el Directorio de la cuenta activa.
 * - `DIRECTORY`: el cliente sólo manda `linkedUserId`, el usuario vinculado a un contacto del
 *   Directorio activo. Nombre, apellido y correo los resuelve el backend desde ese usuario, y el
 *   payload que los traiga se rechaza (historia "Implementar creación transaccional de
 *   colaboradores desde Directorio y captura manual"): el contrato no deja lugar a datos de
 *   identidad que el backend fuera a ignorar.
 *
 * Un contacto del Directorio SIN usuario vinculado no puede usar `DIRECTORY` —no hay usuario ni
 * correo de plataforma que resolver—: se envía como `MANUAL` con sus datos completos.
 */
export enum PAYLOAD_COLLABORATOR_SOURCE_ENUM {
  DIRECTORY = 'DIRECTORY',
  MANUAL = 'MANUAL',
}

/**
 * Indica si un colaborador del payload viene del Directorio.
 *
 * @param collaborator - Colaborador del payload.
 * @returns `true` sólo si `source` es `DIRECTORY`.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * isDirectoryCollaborator({ source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.DIRECTORY }); // true
 * isDirectoryCollaborator({ source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.MANUAL }); // false
 * ```
 */
export function isDirectoryCollaborator(
  collaborator: Pick<CollaboratorPayloadDto, 'source'>,
): boolean {
  return collaborator.source === PAYLOAD_COLLABORATOR_SOURCE_ENUM.DIRECTORY;
}

/** Campos que sólo pertenecen al origen MANUAL: la identidad capturada y el alta en Directorio. */
const MANUAL_ONLY_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'addToDirectory',
] as const;

/** Campos que sólo pertenecen al origen DIRECTORY. */
const DIRECTORY_ONLY_FIELDS = ['linkedUserId'] as const;

type SourceFields = Pick<
  CollaboratorPayloadDto,
  'source' | (typeof MANUAL_ONLY_FIELDS)[number] | 'linkedUserId'
>;

/**
 * Campos presentes en el colaborador que su `source` no admite.
 *
 * Un campo cuenta como "enviado" si no es `undefined`: un `null` explícito también se rechaza,
 * porque quien lo manda está diciendo algo sobre un campo que no le corresponde a ese origen.
 *
 * @param collaborator - Colaborador del payload.
 * @returns Los nombres de los campos sobrantes, en orden fijo; vacío si no sobra ninguno o si
 *   `source` no es un valor válido (eso lo reporta su propio validador).
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * forbiddenFieldsForSource({ source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.DIRECTORY, email: 'a@b.c' });
 * // ['email']
 * ```
 */
export function forbiddenFieldsForSource(collaborator: SourceFields): string[] {
  const forbidden =
    collaborator.source === PAYLOAD_COLLABORATOR_SOURCE_ENUM.DIRECTORY
      ? MANUAL_ONLY_FIELDS
      : collaborator.source === PAYLOAD_COLLABORATOR_SOURCE_ENUM.MANUAL
        ? DIRECTORY_ONLY_FIELDS
        : [];
  return forbidden.filter((field) => collaborator[field] !== undefined);
}

/**
 * Todo lo que hace inválido a un colaborador según su `source`: origen ausente o desconocido,
 * campos obligatorios que faltan y campos que ese origen no admite.
 *
 * Es la regla completa en un solo lugar. El DTO la reparte entre los validadores de cada campo
 * (formato y obligatoriedad) y `CollaboratorSourceFieldsConstraint` (campos sobrantes);
 * `CreateDocumentSignatureFlowUseCase` la aplica entera, para no depender de que lo llamen a
 * través del `ValidationPipe`.
 *
 * @param collaborator - Colaborador del payload.
 * @returns Mensajes en español, uno por problema; vacío si el colaborador es coherente.
 *
 * @throws Nada.
 *
 * @example
 * ```ts
 * collaboratorSourceViolations({ source: PAYLOAD_COLLABORATOR_SOURCE_ENUM.MANUAL, firstName: 'Ana' });
 * // ['Con source MANUAL son obligatorios: lastName, email, addToDirectory']
 * ```
 */
export function collaboratorSourceViolations(
  collaborator: SourceFields,
): string[] {
  if (
    !Object.values(PAYLOAD_COLLABORATOR_SOURCE_ENUM).includes(
      collaborator.source as PAYLOAD_COLLABORATOR_SOURCE_ENUM,
    )
  ) {
    return ['source es obligatorio y debe ser DIRECTORY o MANUAL'];
  }

  const required =
    collaborator.source === PAYLOAD_COLLABORATOR_SOURCE_ENUM.DIRECTORY
      ? DIRECTORY_ONLY_FIELDS
      : MANUAL_ONLY_FIELDS;
  const missing = required.filter(
    (field) =>
      collaborator[field] === undefined ||
      collaborator[field] === null ||
      collaborator[field] === '',
  );
  const forbidden = forbiddenFieldsForSource(collaborator);

  return [
    ...(missing.length
      ? [
          `Con source ${collaborator.source} son obligatorios: ${missing.join(', ')}`,
        ]
      : []),
    ...(forbidden.length
      ? [
          `Con source ${collaborator.source} no se aceptan: ${forbidden.join(', ')}`,
        ]
      : []),
  ];
}

/**
 * Rechaza los campos que el `source` del colaborador no admite (ver `forbiddenFieldsForSource`).
 *
 * Va sobre la propiedad `source` y no sobre cada campo: con `ValidateIf`, los validadores de un
 * campo se saltan TODOS juntos cuando la condición no se cumple, así que no hay forma de decir en
 * el mismo campo "obligatorio para MANUAL" y "prohibido para DIRECTORY".
 */
@ValidatorConstraint({ name: 'collaboratorSourceFields', async: false })
export class CollaboratorSourceFieldsConstraint implements ValidatorConstraintInterface {
  /**
   * Indica si el colaborador no trae campos ajenos a su origen.
   *
   * @param _source - Valor de `source` (se lee del objeto completo).
   * @param args - Argumentos de class-validator; `object` es el colaborador.
   * @returns `true` si no sobra ningún campo.
   *
   * @throws Nada.
   *
   * @example
   * ```ts
   * new CollaboratorSourceFieldsConstraint().validate('DIRECTORY', { object: { source: 'DIRECTORY' } } as never); // true
   * ```
   */
  validate(_source: unknown, args: ValidationArguments): boolean {
    return (
      forbiddenFieldsForSource(args.object as CollaboratorPayloadDto).length ===
      0
    );
  }

  /**
   * Mensaje con los campos sobrantes.
   *
   * @param args - Argumentos de class-validator; `object` es el colaborador.
   * @returns El mensaje de error.
   *
   * @throws Nada.
   *
   * @example
   * ```ts
   * // 'Con source DIRECTORY no se aceptan: firstName, email'
   * ```
   */
  defaultMessage(args: ValidationArguments): string {
    const collaborator = args.object as CollaboratorPayloadDto;
    return `Con source ${collaborator.source} no se aceptan: ${forbiddenFieldsForSource(collaborator).join(', ')}`;
  }
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
  BIOMETRIC = 'BIOMETRIC',
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

  /**
   * Discriminador del origen. Obligatorio: desde la historia "Implementar creación transaccional de
   * colaboradores desde Directorio y captura manual" ya no hay un origen por omisión, porque cada
   * origen exige campos distintos (`addToDirectory` en MANUAL, `linkedUserId` en DIRECTORY).
   */
  @ApiProperty({
    enum: PAYLOAD_COLLABORATOR_SOURCE_ENUM,
    description:
      '`MANUAL` (datos capturados) o `DIRECTORY` (sólo `linkedUserId`; el backend resuelve la identidad).',
  })
  @IsEnum(PAYLOAD_COLLABORATOR_SOURCE_ENUM, {
    message: 'source es obligatorio y debe ser DIRECTORY o MANUAL',
  })
  @Validate(CollaboratorSourceFieldsConstraint)
  source: PAYLOAD_COLLABORATOR_SOURCE_ENUM;

  /**
   * `users.id` del usuario vinculado al contacto del Directorio. Obligatorio con `source:
   * 'DIRECTORY'`; con `MANUAL` se rechaza. Que exista y que esté vinculado a un contacto vigente
   * del Directorio de la cuenta activa lo comprueba `CreateDocumentSignatureFlowUseCase`, no este
   * DTO.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Obligatorio con `source: DIRECTORY`; no se acepta con `MANUAL`.',
  })
  @ValidateIf((c: CollaboratorPayloadDto) => isDirectoryCollaborator(c))
  @IsUUID()
  linkedUserId?: string;

  /**
   * Nombre, apellido y correo: obligatorios con `MANUAL` y rechazados con `DIRECTORY` (lo segundo
   * lo comprueba `CollaboratorSourceFieldsConstraint`, sobre `source`).
   */
  @ApiPropertyOptional({
    example: 'Juan',
    description: 'Obligatorio con `source: MANUAL`.',
  })
  @ValidateIf((c: CollaboratorPayloadDto) => !isDirectoryCollaborator(c))
  @IsString()
  @IsNotEmpty()
  firstName?: string;

  @ApiPropertyOptional({
    example: 'Pérez',
    description: 'Obligatorio con `source: MANUAL`.',
  })
  @ValidateIf((c: CollaboratorPayloadDto) => !isDirectoryCollaborator(c))
  @IsString()
  @IsNotEmpty()
  lastName?: string;

  @ApiPropertyOptional({
    example: 'juan.perez@mail.com',
    description: 'Obligatorio con `source: MANUAL`.',
  })
  @ValidateIf((c: CollaboratorPayloadDto) => !isDirectoryCollaborator(c))
  @IsEmail()
  email?: string;

  /**
   * Si el colaborador capturado a mano debe quedar en el Directorio de la cuenta activa.
   * Obligatorio con `MANUAL` —el cliente decide siempre, no hay valor por omisión— y rechazado con
   * `DIRECTORY`, porque ese contacto ya está en el Directorio.
   */
  @ApiPropertyOptional({
    description:
      'Obligatorio con `source: MANUAL` (crea o reutiliza el contacto en el Directorio activo); no se acepta con `DIRECTORY`.',
  })
  @ValidateIf((c: CollaboratorPayloadDto) => !isDirectoryCollaborator(c))
  @IsBoolean({ message: 'addToDirectory es obligatorio con source MANUAL' })
  addToDirectory?: boolean;

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
