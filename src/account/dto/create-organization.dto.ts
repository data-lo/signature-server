import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateOrganizationDto {
  @ApiProperty({
    example: 'Acme',
    description: 'Nombre de visualización del espacio de trabajo',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'Acme Corp S.A. de C.V.',
    description: 'Razón social o nombre legal completo de la empresa',
  })
  @IsString()
  @IsNotEmpty()
  organizationName: string;

  @ApiPropertyOptional({ example: 'Av. Reforma 123, CDMX' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: 'ACM010101AAA' })
  @IsOptional()
  @IsString()
  rfc?: string;

  @ApiPropertyOptional({ example: 'acme.com' })
  @IsOptional()
  @IsString()
  domainAllowed?: string;

  @ApiPropertyOptional({ example: '5512345678' })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  indexDocuments?: boolean;
}
