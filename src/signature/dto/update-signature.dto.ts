import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSignatureDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description:
      'Nueva imagen PNG de la firma  o Imagen reemplazada por PNG en blanco (opcional)',
  })
  signatureImage?: any;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Nueva imagen de la identificación oficial (opcional)',
  })
  officialFile?: any;
}
