import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class CreateSignatureDto {
  @ApiProperty({
    description: 'Identificador único del usuario al que se asignará la firma en formato UUID v4. Al registrar la firma, su ID queda vinculado automáticamente al usuario.',
    format: 'uuid',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsUUID()
  @IsNotEmpty()
  userId: string;

  @ApiPropertyOptional({
    description: 'Identificador único del usuario que registra la firma (administrador o responsable) en formato UUID v4. Si no se envía, el campo quedará en null.',
    format: 'uuid',
    example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  })
  @IsUUID()
  @IsOptional()
  createdBy?: string;

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