import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsString,
  ValidateNested,
  IsOptional
} from 'class-validator';
import { Type } from 'class-transformer';

export class DocumentCoordDto {
  @ApiProperty({ example: 50, description: 'Coordenada horizontal de la firma en el documento (px)' })
  @IsNumber()
  x: number;

  @ApiProperty({ example: 250, description: 'Coordenada vertical de la firma en el documento (px)' })
  @IsNumber()
  y: number;

  @ApiProperty({ example: 700, description: 'Ancho de la firma en el documento (px)' })
  @IsNumber()
  width: number;

  @ApiProperty({ example: 780, description: 'Alto de la firma en el documento (px)' })
  @IsNumber()
  height: number;
}

export class CreateDocumentDto {

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', description: 'UUID del usuario que sube el documento', format: 'uuid' })
  @IsString()
  @IsNotEmpty()
  signerId: string;


  @ApiProperty({ example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', description: 'UUID del usuario que solicita la firma', format: 'uuid' })
  @IsString()
  @IsNotEmpty()
  createdById: string;

  @ApiProperty({ type: DocumentCoordDto, description: 'Coordenadas donde se colocará la firma en el documento' })
  @ValidateNested()
  @Type(() => DocumentCoordDto)
  @IsOptional()
  coord: DocumentCoordDto;
}
