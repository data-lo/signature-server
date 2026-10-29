import { ApiProperty } from '@nestjs/swagger';
import { SignatureCoordinatesDto } from 'src/document/dto/signature-coordinates.dto';
import { BaseResponse } from 'src/interfaces/api-response.dto';

export class UpdateDocumentData {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID del documento',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    example:
      'http://31.97.132.137:9010/created-documents/a1b2c3d4.pdf?X-Amz-Algorithm=...',
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
    type: SignatureCoordinatesDto,
    description: 'Coordenadas de la firma en el documento',
  })
  signatureCoordinates: SignatureCoordinatesDto;
}

export class DocumentUpdateResponse extends BaseResponse<UpdateDocumentData> {
  @ApiProperty({
    type: UpdateDocumentData,
    description: 'Datos del documento registrado',
  })
  data: UpdateDocumentData;
}
