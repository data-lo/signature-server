import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

/** Largo máximo del nombre administrativo de una llave. */
export const API_KEY_NAME_MAX_LENGTH = 100;

/** Tope de permisos por llave: holgado frente a la lista blanca, y acota el tamaño del body. */
export const API_KEY_MAX_PERMISSIONS = 50;

/**
 * Recorta los espacios de un texto; deja cualquier otro valor tal cual para que lo rechace la
 * validación.
 *
 * @param params - El valor recibido, envuelto por `class-transformer`.
 * @returns El texto recortado, o el valor original si no es texto.
 *
 * @example
 * ```ts
 * trimText({ value: '  ERP  ' }); // 'ERP'
 * ```
 */
export function trimText({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/** `POST /api/v1/organizations/:organizationId/api-keys`. */
export class CreateOrganizationApiKeyDto {
  @ApiProperty({
    example: 'Integración ERP',
    description: 'Nombre administrativo de la llave',
    maxLength: API_KEY_NAME_MAX_LENGTH,
  })
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(API_KEY_NAME_MAX_LENGTH)
  name: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    example: ['8f0c6f8e-3b8b-4c55-9d43-1f2b7f0f0a11'],
    description:
      'Ids de `permissions` que se conceden a la llave. Sólo se admiten los permisos de documentos y directorio expuestos a integraciones; los administrativos (organización, miembros, roles, facturación, API keys) se rechazan con 422.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(API_KEY_MAX_PERMISSIONS)
  @IsUUID('all', { each: true })
  permissionIds: string[];

  @ApiPropertyOptional({
    example: '2027-10-26T00:00:00.000Z',
    nullable: true,
    description:
      'Fecha de expiración en ISO 8601; debe ser futura. Omitida o `null`, la llave no vence.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string | null;
}
