import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSignatureDto {
  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Nueva imagen PNG de la firma (opcional)',
  })
  imagen_firma?: any;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Nueva imagen de la identificación oficial (opcional)',
  })
  imagen_ine?: any;
}
