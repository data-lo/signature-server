import { ApiProperty } from '@nestjs/swagger';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';

/**
 * Un documento visto desde la API de integración: sin colaboradores, sin creador, sin URL del
 * archivo. Sólo lo necesario para que el sistema externo siga el estado del documento.
 */
export class IntegrationDocumentData {
  @ApiProperty({
    format: 'uuid',
    example: '7d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b',
  })
  id: string;

  @ApiProperty({ example: 'contrato.pdf' })
  fileName: string;

  @ApiProperty({
    enum: DOCUMENT_STATUS_ENUM,
    example: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
  })
  status: DOCUMENT_STATUS_ENUM;

  @ApiProperty({
    enum: SIGNATURE_TYPE_ENUM,
    nullable: true,
    example: SIGNATURE_TYPE_ENUM.SIMPLE,
    description:
      '`FIEL` es la firma avanzada; `null` en documentos antiguos sin un tipo único',
  })
  signatureType: SIGNATURE_TYPE_ENUM | null;

  @ApiProperty({ example: '2026-10-26T12:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({
    nullable: true,
    type: Date,
    example: null,
    description:
      'Momento en que la última firma cerró el documento; `null` mientras tanto',
  })
  signedAt: Date | null;
}

export class IntegrationDocumentsPagination {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({
    example: 25,
    description: 'Tamaño de página aplicado (máximo 100)',
  })
  limit: number;

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 2 })
  totalPages: number;
}

export class IntegrationDocumentsPage {
  @ApiProperty({ type: [IntegrationDocumentData] })
  items: IntegrationDocumentData[];

  @ApiProperty({ type: IntegrationDocumentsPagination })
  pagination: IntegrationDocumentsPagination;
}

export class IntegrationDocumentsPageResponse extends BaseResponse<IntegrationDocumentsPage> {
  @ApiProperty({ type: IntegrationDocumentsPage })
  data: IntegrationDocumentsPage;
}

export class IntegrationDocumentResponse extends BaseResponse<IntegrationDocumentData> {
  @ApiProperty({ type: IntegrationDocumentData })
  data: IntegrationDocumentData;
}
