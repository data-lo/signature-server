import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import {
  DOCUMENT_SORT_FIELD_ENUM,
  SORT_DIRECTION_ENUM,
} from '../enum/document-sort-field.enum';
import { DOCUMENT_VIEW_ENUM } from '../enum/document-view.enum';

/** Tope de longitud de los campos de texto libre, para que una búsqueda no llegue como un ensayo. */
const MAX_SEARCH_LENGTH = 200;

/**
 * Todo lo que el listado unificado acepta por query string, y nada más.
 *
 * **La cuenta activa NO está acá y es deliberado.** Viaja en el header `X-Account-Id` y el caso
 * de uso comprueba que quien pregunta sea miembro de ella. Aceptarla como un parámetro más de la
 * query convertiría el filtro en un selector: bastaría cambiar un UUID en la barra de direcciones
 * para pedir la bandeja de otra cuenta, y el endpoint no tendría cómo distinguir eso de un uso
 * legítimo.
 *
 * Los parámetros de las tres pantallas segmentadas —`participantEmail`, `email`, `status`,
 * `fileName`, `participantName`, `myTurnOnly`— ya no existen. Cada uno describía un pedazo de la
 * consulta que armaba el frontend; `view`, `search`, `participant` y `statuses` describen lo que
 * el usuario quiere ver, que es lo que un cliente sí puede saber.
 */
export class GetDocumentsQueryDto {
  @ApiPropertyOptional({
    enum: DOCUMENT_VIEW_ENUM,
    default: DOCUMENT_VIEW_ENUM.REQUIRES_MY_SIGNATURE,
    description:
      'Recorte principal del listado. Por omisión, lo que espera una acción del usuario.',
  })
  @IsOptional()
  @IsEnum(DOCUMENT_VIEW_ENUM)
  view?: DOCUMENT_VIEW_ENUM = DOCUMENT_VIEW_ENUM.REQUIRES_MY_SIGNATURE;

  @ApiPropertyOptional({
    description:
      'Búsqueda libre: nombre del documento o nombre/correo de cualquiera de sus participantes.',
    maxLength: MAX_SEARCH_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @ApiPropertyOptional({
    enum: DOCUMENT_STATUS_ENUM,
    isArray: true,
    description:
      'Uno o varios estatus del documento. Repetible (`?statuses=pending&statuses=signed`) o separado por comas.',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(DOCUMENT_STATUS_ENUM, { each: true })
  /**
   * Un solo `?statuses=pending` llega como cadena y no como arreglo: Express no puede adivinar
   * que el parámetro era una lista de un elemento. Sin normalizarlo, `@IsArray` lo rechazaría y
   * filtrar por un único estado —el caso más común— respondería 400.
   */
  @Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    const raw = Array.isArray(value) ? value : String(value).split(',');
    return raw.map((item) => String(item).trim()).filter(Boolean);
  })
  statuses?: DOCUMENT_STATUS_ENUM[];

  @ApiPropertyOptional({
    description:
      'Nombre o correo de un participante (firmante, revisor u observador) del documento.',
    maxLength: MAX_SEARCH_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  participant?: string;

  @ApiPropertyOptional({
    description: 'Creados desde (ISO 8601)',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({
    description: 'Creados hasta (ISO 8601)',
    example: '2026-12-31',
  })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @ApiPropertyOptional({
    description: 'Firmados desde (ISO 8601)',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString()
  signedFrom?: string;

  @ApiPropertyOptional({
    description: 'Firmados hasta (ISO 8601)',
    example: '2026-12-31',
  })
  @IsOptional()
  @IsDateString()
  signedTo?: string;

  @ApiPropertyOptional({
    enum: DOCUMENT_SORT_FIELD_ENUM,
    default: DOCUMENT_SORT_FIELD_ENUM.CREATED_AT,
    description:
      'Campo por el que se ordena. Lista cerrada, no un nombre de columna.',
  })
  @IsOptional()
  @IsEnum(DOCUMENT_SORT_FIELD_ENUM)
  sortBy?: DOCUMENT_SORT_FIELD_ENUM = DOCUMENT_SORT_FIELD_ENUM.CREATED_AT;

  @ApiPropertyOptional({
    enum: SORT_DIRECTION_ENUM,
    default: SORT_DIRECTION_ENUM.DESC,
  })
  @IsOptional()
  @IsEnum(SORT_DIRECTION_ENUM)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  sortDirection?: SORT_DIRECTION_ENUM = SORT_DIRECTION_ENUM.DESC;

  @ApiPropertyOptional({ description: 'Página', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Resultados por página',
    default: 25,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  @ApiPropertyOptional({
    description:
      'UUID de un documento concreto. No es un atajo al detalle: sirve para comprobar si ESE documento entra en el listado con los filtros dados.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({
    description:
      'Incluir la URL prefirmada de cada documento. Cuesta una llamada a MinIO por resultado, así que va apagado salvo que el llamador la necesite.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  withUrl?: boolean = false;
}
