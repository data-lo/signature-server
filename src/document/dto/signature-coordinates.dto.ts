import { IsNumber, IsPositive, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignatureCoordinatesDto {
  @ApiProperty({
    example: 50,
    description: 'Coordenada horizontal de la firma en el documento (px)',
  })
  @IsNumber()
  @Min(0)
  x: number;

  @ApiProperty({
    example: 250,
    description: 'Coordenada vertical de la firma en el documento (px)',
  })
  @IsNumber()
  @Min(0)
  y: number;

  @ApiProperty({
    example: 700,
    description: 'Ancho de la firma en el documento (px)',
  })
  @IsNumber()
  @IsPositive()
  width: number;

  @ApiProperty({
    example: 780,
    description: 'Alto de la firma en el documento (px)',
  })
  @IsNumber()
  @IsPositive()
  height: number;
}
