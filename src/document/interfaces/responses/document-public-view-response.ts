import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';

/**
 * Constancia de conservación NOM-151 emitida por el PSC. Los mismos tres renglones que imprime la
 * hoja de evidencia anexada al PDF (ver `ConservationRecordInfo`).
 */
export class PublicConservationRecordData {
  @ApiProperty({
    example: null,
    description:
      'Identidad del certificado de la Autoridad de Sellado de Tiempo (DN del PSC). Hoy SIEMPRE null: el dato viaja dentro del token RFC 3161 y ni PSC CODEX ni Seal Service lo exponen por separado — ver la nota de `toConservationRecord`.',
    nullable: true,
  })
  tsaCertificate: string | null;

  @ApiProperty({
    example: null,
    description:
      'Número de serie del sello de tiempo. Mismo caso que tsaCertificate: hoy siempre null.',
    nullable: true,
  })
  serialNumber: string | null;

  @ApiProperty({
    example: '2026-08-14T18:24:11.000Z',
    description:
      'Momento en que el PSC emitió la constancia (SealEntity.sealedAt). Único renglón de los tres que hoy se puede llenar.',
    format: 'date-time',
    nullable: true,
  })
  issuedAt: string | null;
}

/**
 * Evidencia pública de UNA firma. Los campos que no aplican al tipo de firma vienen en `null`: la
 * vista pública oculta el renglón entero en vez de pintarlo vacío, y así los campos exclusivos de
 * un tipo nunca se muestran para el otro.
 *
 * Es la misma evidencia que ya se imprime en la hoja de firmas anexada al PDF — quien tiene el
 * documento en la mano la lee ahí. Esta ruta no la vuelve más pública de lo que ya era, pero sí es
 * la razón por la que no se agrega nada que la hoja no imprima (correo del firmante, por ejemplo).
 */
export class PublicSignerData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del colaborador firmante',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    example: 'MANUEL BALDERRAMA CHAVEZ',
    description:
      'Nombre del firmante. En firma avanzada se prefiere el del certificado de e.firma (el que el SAT tiene registrado); si no, el de su perfil o el email con el que fue invitado.',
  })
  name: string;

  @ApiProperty({
    example: SIGNATURE_TYPE_ENUM.FIEL,
    description:
      'Tipo de firma con el que participó. Determina qué campos de evidencia vienen resueltos.',
    enum: SIGNATURE_TYPE_ENUM,
    nullable: true,
  })
  signatureType: SIGNATURE_TYPE_ENUM | null;

  @ApiProperty({
    example: 'Firma Electronica Avanzada',
    description:
      'Rótulo del mecanismo de firma, idéntico al que imprime la hoja de evidencia del PDF.',
  })
  signatureTypeLabel: string;

  @ApiProperty({
    example:
      'Certificado emitido por el Sistema de Administración Tributaria PSC (Art. 97 del Código de Comercio)',
    description:
      'Fundamento legal de la firma ("Sustentada"). Lo sirve el backend —y no lo escribe el frontend— para que la pantalla y el documento impreso no puedan divergir.',
  })
  legalBacking: string;

  @ApiProperty({ example: '187.190.12.4', description: 'IP desde la que firmó' })
  ipAddress: string;

  @ApiProperty({
    example: '2026-08-14T18:24:11.000Z',
    description: 'Momento en que completó su firma (UTC).',
    format: 'date-time',
    nullable: true,
  })
  signedAt: string | null;

  @ApiProperty({
    example: '19.4326, -99.1332',
    description:
      'Geolocalización declarada por el dispositivo al firmar, ya formateada. null si no se capturó.',
    nullable: true,
  })
  geoLocation: string | null;

  @ApiProperty({
    example: '482915',
    description:
      'Código de un solo uso con el que se verificó su identidad. SOLO en firma simple; null en firma avanzada, donde la identidad la acredita el certificado del SAT.',
    nullable: true,
  })
  otpCode: string | null;

  @ApiProperty({
    example: '00001000000512345678',
    description:
      'Número de serie del certificado de e.firma. SOLO en firma avanzada; null en firma simple.',
    nullable: true,
  })
  certificateSerialNumber: string | null;

  @ApiProperty({
    example: 'MEUCIQDf...',
    description:
      'Firma electrónica en base64 (`advancedSignature.signatureBase64`). SOLO en firma avanzada; null en firma simple.',
    nullable: true,
  })
  electronicSignature: string | null;
}

/** Artefactos de la constancia del PSC que se pueden descargar de un documento completado. */
export class PublicSealDownloadsData {
  @ApiProperty({
    example: true,
    description:
      'Constancia de conservación NOM-151 en PDF, emitida por el PSC (GET /document/public/:id/seal/nom151).',
  })
  nom151: boolean;

  @ApiProperty({
    example: true,
    description:
      'Token de sello de tiempo RFC 3161 (GET /document/public/:id/seal/timestamp).',
  })
  timestamp: boolean;

  @ApiProperty({
    example: true,
    description:
      'Cadena canónica sellada — la preimagen literal del hash (GET /document/public/:id/seal/canonical).',
  })
  canonical: boolean;
}

export class DocumentPublicViewData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del documento',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    example: 'Convenio_2026_Manuel_Balderrama.pdf',
    description: 'Nombre original del archivo subido',
  })
  fileName: string;

  @ApiProperty({
    example: DOCUMENT_STATUS_ENUM.SIGNED,
    description: 'Estatus actual del documento',
    enum: DOCUMENT_STATUS_ENUM,
  })
  status: DOCUMENT_STATUS_ENUM;

  @ApiProperty({
    example: true,
    description:
      'true solo cuando el documento ya fue firmado por todos sus participantes (status SIGNED). Es el interruptor de la vista pública: en false, todos los campos de evidencia de abajo vienen vacíos o en null a propósito.',
  })
  isCompleted: boolean;

  @ApiProperty({
    example:
      'http://31.97.132.137:9010/finalized-documents/a1b2c3d4.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&...',
    description:
      'URL segura y prefirmada de MinIO para visualizar el archivo. Solo se genera y expone cuando status es SIGNED; en cualquier otro estatus es null.',
    nullable: true,
  })
  secureUrl: string | null;

  @ApiProperty({
    example: 86400,
    description:
      'Vigencia en segundos de secureUrl. null cuando el documento no está firmado (no se generó URL).',
    nullable: true,
  })
  expiresIn: number | null;

  @ApiProperty({
    example: '9f2b8c1d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c',
    description:
      'Hash del documento firmado (DocumentEntity.signedHash). null mientras el documento no esté completado.',
    nullable: true,
  })
  hash: string | null;

  @ApiProperty({
    example: 12,
    description:
      'Número de páginas del documento. null mientras no esté completado.',
    nullable: true,
  })
  totalPages: number | null;

  @ApiProperty({
    example: 'contacto@firmalo.mx',
    description:
      'Quién creó el documento — el mismo dato que imprime la hoja de evidencia (email del creador). null mientras no esté completado.',
    nullable: true,
  })
  createdBy: string | null;

  @ApiProperty({
    type: PublicConservationRecordData,
    description:
      'Constancia NOM-151 del PSC. null cuando el documento no está completado, y también cuando sí lo está pero no tiene sello: solo se sellan los documentos con firma AVANZADA (ver `sealAdvancedSignatures`), y el sellado es best-effort.',
    nullable: true,
  })
  conservationRecord: PublicConservationRecordData | null;

  @ApiProperty({
    type: [PublicSignerData],
    description:
      'Firmantes del documento. Mientras el documento está pendiente solo trae `id` y `name` (el resto en null): la vista pública no muestra estatus individual ni evidencia hasta que la firma se completa.',
  })
  signers: PublicSignerData[];

  @ApiProperty({
    type: PublicSealDownloadsData,
    description:
      'Qué artefactos de la constancia están disponibles para descargar. Todos en false si el documento no está completado o no tiene sello.',
  })
  downloads: PublicSealDownloadsData;
}

export class DocumentPublicViewResponse extends BaseResponse {
  @ApiProperty({
    type: DocumentPublicViewData,
    description: 'Datos públicos de verificación del documento',
  })
  data: DocumentPublicViewData;
}
