import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';

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
    example:
      'http://31.97.132.137:9010/signed-documents/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...',
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
}

export class DocumentPublicViewResponse extends BaseResponse {
  @ApiProperty({
    type: DocumentPublicViewData,
    description:
      'Datos públicos del documento (sin información de participantes)',
  })
  data: DocumentPublicViewData;
}
