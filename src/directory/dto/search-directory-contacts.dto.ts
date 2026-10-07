import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  MAX_CONTACT_EMAIL_LENGTH,
  trimString,
} from './create-directory-contact.dto';

/** Resultados por omisión de una búsqueda. */
export const DEFAULT_CONTACT_SEARCH_LIMIT = 25;

/** Tope de resultados de una búsqueda: es un buscador, no una exportación. */
export const MAX_CONTACT_SEARCH_LIMIT = 100;

/**
 * Query de `GET /directory-contacts?email=`.
 *
 * `email` es un FRAGMENTO, no un correo completo: la búsqueda es parcial (`ana` encuentra
 * `ana.garcia@example.com` y `mariana@example.com`), así que no se valida con `IsEmail`.
 */
export class SearchDirectoryContactsDto {
  @ApiProperty({
    example: 'garcia',
    maxLength: MAX_CONTACT_EMAIL_LENGTH,
    description:
      'Fragmento del correo. Sin distinguir mayúsculas y en cualquier parte del correo.',
  })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'Indica el correo a buscar' })
  @MaxLength(MAX_CONTACT_EMAIL_LENGTH)
  email: string;

  @ApiPropertyOptional({
    example: DEFAULT_CONTACT_SEARCH_LIMIT,
    minimum: 1,
    maximum: MAX_CONTACT_SEARCH_LIMIT,
    default: DEFAULT_CONTACT_SEARCH_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CONTACT_SEARCH_LIMIT)
  limit?: number;
}
