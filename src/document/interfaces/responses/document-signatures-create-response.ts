import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse } from '../../../interfaces/api-response.dto';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';

export class CreateDocumentSignaturesData {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: DOCUMENT_STATUS_ENUM,
    example: DOCUMENT_STATUS_ENUM.PENDING,
  })
  status: DOCUMENT_STATUS_ENUM;

  @ApiProperty({
    example: 2,
    description: 'Firmantes + reviewers + viewers creados',
  })
  collaboratorsCount: number;

  @ApiProperty({ example: 2 })
  notificationsCount: number;

  @ApiProperty({
    example: 1,
    description:
      'Cuántos de los colaboradores requirieron código de verificación (2FA)',
  })
  verificationCodesCount: number;
}

export class DocumentSignaturesCreateResponse extends BaseResponse<CreateDocumentSignaturesData> {
  @ApiProperty({ type: CreateDocumentSignaturesData })
  data: CreateDocumentSignaturesData;
}
