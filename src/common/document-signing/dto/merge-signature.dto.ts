import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class MergeSignatureDto {
  @ApiPropertyOptional({
    description: 'Posición X desde el borde izquierdo (puntos PDF)',
    example: 60,
  })
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  x?: number;

  @ApiPropertyOptional({
    description: 'Posición Y desde el borde inferior (puntos PDF)',
    example: 40,
  })
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  y?: number;

  @ApiPropertyOptional({
    description: 'Ancho de la firma (puntos PDF, rango 60–320)',
    example: 200,
  })
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  width?: number;

  @ApiPropertyOptional({
    description: 'Alto de la firma (puntos PDF, rango 24–128)',
    example: 80,
  })
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  height?: number;

  @ApiPropertyOptional({
    description:
      'Opacidad de la firma: 0.0 invisible — 1.0 completamente opaco',
    example: 1.0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  @Transform(({ value }) => Number(value))
  opacity?: number;
}
