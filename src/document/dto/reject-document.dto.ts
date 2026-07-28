import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RejectDocumentDto {
  @ApiProperty({
    example: 'El monto indicado en la cláusula 3 no corresponde al acordado.',
    description: 'Motivo por el cual se rechaza el documento',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(5, { message: 'Describe con más detalle el motivo del rechazo' })
  reason: string;
}
