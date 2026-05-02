import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class CreateSignatureDto {
  @ApiProperty({
    description: 'UUID del usuario al que se asignará esta firma. Al crear la firma, su ID se asigna automáticamente al usuario.',
    format: 'uuid',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsUUID()
  @IsNotEmpty()
  userId: string;

  @ApiPropertyOptional({
    description: 'UUID del usuario que registra la firma (administrador o responsable). Queda en null si no se envía.',
    format: 'uuid',
    example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  })
  @IsUUID()
  @IsOptional()
  createdBy?: string;
}
