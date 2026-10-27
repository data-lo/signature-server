import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import {
  API_KEY_MAX_PERMISSIONS,
  API_KEY_NAME_MAX_LENGTH,
  trimText,
} from './create-organization-api-key.dto';

/**
 * `POST /api/v1/organizations/:organizationId/api-keys/rotate`. Todo es opcional: lo que se
 * omite se hereda de la llave que se revoca, salvo `expiresAt`.
 */
export class RotateOrganizationApiKeyDto {
  @ApiPropertyOptional({
    example: 'Integración ERP - llave 2027',
    description:
      'Nombre de la llave nueva. Omitido, se conserva el de la vigente.',
    maxLength: API_KEY_NAME_MAX_LENGTH,
  })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(API_KEY_NAME_MAX_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    example: ['8f0c6f8e-3b8b-4c55-9d43-1f2b7f0f0a11'],
    description:
      'Permisos de la llave nueva. Omitidos, se conservan los de la vigente (y se vuelven a validar contra la política).',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(API_KEY_MAX_PERMISSIONS)
  @IsUUID('all', { each: true })
  permissionIds?: string[];

  @ApiPropertyOptional({
    example: '2028-10-26T00:00:00.000Z',
    nullable: true,
    description:
      'Expiración de la llave nueva; debe ser futura. NO se hereda: omitida o `null`, la llave nueva no vence.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string | null;
}
