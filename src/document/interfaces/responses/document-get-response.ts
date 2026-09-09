import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { DOCUMENT_PARTICIPATION_ENUM } from '../../enum/document-participation.enum';

export class DocumentGetData {
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
    example: 'application/pdf',
    description: 'Tipo MIME del archivo',
  })
  fileType: string;

  @ApiProperty({
    example: 12,
    description: 'Total de páginas del documento PDF',
  })
  totalPages: number;

  @ApiProperty({
    example: 'created',
    description: 'Estatus actual del documento',
    enum: DOCUMENT_STATUS_ENUM,
  })
  status: string;

  @ApiProperty({
    example: '2026-05-14T07:33:29.821Z',
    description: 'Fecha de creación del documento',
  })
  createdAt: Date;

  @ApiProperty({
    example: '2026-05-20T18:02:11.400Z',
    nullable: true,
    description:
      'Fecha en que el documento quedó firmado por todos sus firmantes. Null mientras el flujo de firma no se haya completado.',
  })
  signedAt: Date | null;

  @ApiProperty({
    example:
      'http://31.97.132.137:9010/created-documents/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...',
    description: 'URL segura y prefirmada para acceder al documento en MinIO',
  })
  secureUrl: string;

  @ApiProperty({
    example: 86400,
    description:
      'Tiempo de expiración de la URL prefirmada en segundos (24 horas)',
  })
  expiresIn: number;

  @ApiProperty({
    example: 'JOSÉ RAMOS PÉREZ',
    description: 'Nombre completo del firmante',
  })
  signer: string;

  @ApiProperty({
    example: 'ALFREDO SÁNCHEZ RAMOS',
    description: 'Nombre completo del firmante',
  })
  creator: string;

  @ApiProperty({
    example: 'SARA850315HN2',
    nullable: true,
    description:
      'RFC de quien creó el documento (personal_information.rfc). Null si el creador todavía no lo registró.',
  })
  creatorRfc: string | null;

  @ApiProperty({
    enum: SIGNATURE_TYPE_ENUM,
    nullable: true,
    description:
      'Tipo de firma con el que se firma este documento, tomado de sus firmantes (es una decisión del documento, igual para todos ellos). Null en los documentos del endpoint antiguo POST /document, que nunca asignaron tipo.',
  })
  signatureType: SIGNATURE_TYPE_ENUM | null;

  @ApiProperty({
    example: true,
    description:
      'Si el documento participa en Búsqueda Inteligente. Lo decide su autor al crearlo y por omisión es `true`. `false` sólo lo excluye de la indexación: el documento sigue en el listado y conserva firma, descarga y auditoría.',
  })
  isIndexable: boolean;

  @ApiProperty({
    enum: DOCUMENT_PARTICIPATION_ENUM,
    description:
      'Qué papel juega en este documento el usuario que consulta. Es un valor derivado y personal: dos personas reciben valores distintos para el mismo documento, y el de una cambia en cuanto firma.',
  })
  participation: DOCUMENT_PARTICIPATION_ENUM;
}

/**
 * Dónde está parado el llamador dentro del total de resultados.
 *
 * Sin `hasNextPage`/`hasPrevPage`: eran dos campos que sólo repetían lo que `page` y `totalPages`
 * ya dicen (`page < totalPages`, `page > 1`), y dos fuentes para el mismo hecho es una de más —
 * en cuanto una se calcula distinto que la otra, la paginación empieza a mentir.
 */
export class DocumentsPaginationResponse {
  @ApiProperty({ example: 1, description: 'Página actual' })
  page: number;

  @ApiProperty({ example: 25, description: 'Cantidad de registros por página' })
  limit: number;

  @ApiProperty({ example: 42, description: 'Total de registros encontrados' })
  total: number;

  @ApiProperty({ example: 2, description: 'Total de páginas' })
  totalPages: number;
}

export class DocumentGetResponse extends BaseResponse {
  @ApiProperty({
    type: DocumentGetData,
    description: 'Datos del documento encontrado',
  })
  data: DocumentGetData;
}

/**
 * El listado unificado responde `{ items, pagination }` **sin el sobre `BaseResponse`** que usa el
 * resto de la API.
 *
 * Es una consulta, no una operación: `success` siempre valdría `true` (un fallo viaja como código
 * HTTP, no dentro del cuerpo) y `message` sería una frase fija que ningún cliente lee. Lo que sí
 * ganan los que la consumen es que `items` y `pagination` estén al mismo nivel, en vez de
 * repartidos entre `data` y `meta`.
 */
export class DocumentsListResponse {
  @ApiProperty({ type: [DocumentGetData], description: 'Documentos de la página' })
  items: DocumentGetData[];

  @ApiProperty({ type: DocumentsPaginationResponse })
  pagination: DocumentsPaginationResponse;
}
