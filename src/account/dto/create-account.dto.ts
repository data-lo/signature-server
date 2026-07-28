import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';

export class CreateAccountDto {
  @ApiProperty({
    example: 'Mi Perfil Freelance',
    description: 'Nombre de visualización del espacio de trabajo',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: ACCOUNT_TYPE_ENUM.PERSONAL,
    description: 'Tipo de entorno de la cuenta',
    enum: ACCOUNT_TYPE_ENUM,
  })
  @IsEnum(ACCOUNT_TYPE_ENUM)
  type: ACCOUNT_TYPE_ENUM;

  @ApiProperty({
    example: 'Acme Corp S.A. de C.V.',
    description:
      'Razón social o nombre legal completo de la empresa, requerido cuando type es ORGANIZATION',
    required: false,
  })
  @ValidateIf(
    (dto: CreateAccountDto) => dto.type === ACCOUNT_TYPE_ENUM.ORGANIZATION,
  )
  @IsString()
  @IsNotEmpty()
  organizationName?: string;

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
