import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';


export class DocumentCoordDto {
  @ApiProperty({ example: 50, description: 'Coordenada izquierda de la firma en el documento (px)' })
  @IsNumber()
  x: number;

  @ApiProperty({ example: 250, description: 'Coordenada derecha de la firma en el documento (px)' })
  @IsNumber()
  y: number;

  @ApiProperty({ example: 700, description: 'Coordenada superior de la firma en el documento (px)' })
  @IsNumber()
  top: number;

  @ApiProperty({ example: 780, description: 'Coordenada inferior de la firma en el documento (px)' })
  @IsNumber()
  bottom: number;
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
  coord: DocumentCoordDto;
}
