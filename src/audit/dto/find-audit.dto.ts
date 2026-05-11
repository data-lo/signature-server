import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO para los query params del endpoint GET /audit.
 *
 * Modos de uso:
 *  - Solo `id`: retorna el registro exacto (sin paginación).
 *  - `dateFrom` / `dateTo`: filtra por rango de fechas en createdAt.
 *  - Sin filtros: retorna todos los registros paginados.
 *
 * `page` y `limit` aplican en todos los casos excepto cuando se filtra por `id`.
 */
export class FindAllAuditDto {
  /** Retorna únicamente el registro con este ID. Tiene precedencia sobre los demás filtros. */
  @ApiPropertyOptional({ description: 'ID del registro de auditoría' })
  @IsOptional()
  @IsString()
  id?: string;

  /** Límite inferior del rango de fechas (inclusive). Formato ISO 8601. */
  @ApiPropertyOptional({ description: 'Fecha de inicio del rango (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  /** Límite superior del rango de fechas (inclusive). Formato ISO 8601. */
  @ApiPropertyOptional({ description: 'Fecha de fin del rango (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  /** Número de página a retornar. Comienza en 1. */
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /** Cantidad máxima de registros por página. */
  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 10;
}
