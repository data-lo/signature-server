import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';

export class GetDocumentsBySignerDto {
  @ApiPropertyOptional({
    enum: DOCUMENT_STATUS_ENUM,
    description: 'Filtrar documentos por estatus',
    example: DOCUMENT_STATUS_ENUM.PENDING,
  })
  @IsOptional()
  @IsEnum(DOCUMENT_STATUS_ENUM)
  status?: DOCUMENT_STATUS_ENUM;
}
