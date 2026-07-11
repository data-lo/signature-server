import { ApiProperty } from '@nestjs/swagger';

export class CreateSignatureDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'Imagen de la firma manuscrita en formato PNG.',
  })
  signatureImage: any;

  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'Documento de identificación oficial del usuario en formato PDF.',
  })
  officialFile: any;
}
