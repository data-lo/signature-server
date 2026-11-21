import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { IsEmail, IsOptional, MaxLength } from 'class-validator';

import { GetDocumentsQueryDto } from '../../dto/get-documents-query.dto';

/**
 * Query de los listados de integración: paginación (`page`, `limit` de 1 a 100, 25 por omisión),
 * orden y filtros por estatus y fechas.
 *
 * Reutiliza las mismas reglas de validación de la bandeja (`GetDocumentsQueryDto`) y deja fuera
 * todo lo que depende de un usuario de la plataforma: vistas, archivado, búsqueda por
 * participante y URL prefirmada. Tampoco existe ningún campo de organización o cuenta: el tenant
 * sale siempre de la API key.
 */
export class ListIntegrationDocumentsQueryDto extends PickType(
  GetDocumentsQueryDto,
  [
    'page',
    'limit',
    'sortBy',
    'sortDirection',
    'statuses',
    'createdFrom',
    'createdTo',
    'signedFrom',
    'signedTo',
  ] as const,
) {}

/**
 * Descripciones de los parámetros tal como los ve un cliente de la API de integración. Las de
 * `GetDocumentsQueryDto` hablan de la bandeja de la plataforma, y su ejemplo de `statuses` usa
 * valores en minúsculas que el validador rechaza. Se aplican sobre la metadata de Swagger de
 * `ListIntegrationDocumentsQueryDto` (que `PickType` ya copió), así que no cambian la bandeja ni
 * la validación: `ApiPropertyOptional` fusiona con lo existente.
 */
const INTEGRATION_QUERY_DESCRIPTIONS: Partial<
  Record<keyof ListIntegrationDocumentsQueryDto, string>
> = {
  statuses:
    'Sólo documentos en estos estados. Repite el parámetro (`?statuses=PENDING_SIGNATURE&statuses=SIGNED`) o sepáralos con comas.',
  createdFrom:
    'Creados a partir de esta fecha (ISO 8601, por ejemplo `2026-01-01`).',
  createdTo: 'Creados hasta esta fecha (ISO 8601).',
  signedFrom:
    'Firmados a partir de esta fecha (ISO 8601). Excluye los que aún no se firman.',
  signedTo: 'Firmados hasta esta fecha (ISO 8601).',
  sortBy: 'Campo por el que se ordena.',
  sortDirection: '`DESC` (por omisión) o `ASC`.',
  page: 'Número de página, desde 1.',
  limit: 'Documentos por página, de 1 a 100.',
};

for (const [property, description] of Object.entries(
  INTEGRATION_QUERY_DESCRIPTIONS,
)) {
  ApiPropertyOptional({ description })(
    ListIntegrationDocumentsQueryDto.prototype,
    property,
  );
}

/**
 * Query de `GET /integration/users/documents`: la del listado más el correo, obligatorio, del
 * miembro de la organización cuyos documentos se piden. El id interno nunca entra ni sale.
 */
export class ListIntegrationUserDocumentsQueryDto extends ListIntegrationDocumentsQueryDto {
  @ApiProperty({
    example: 'ana.lopez@cliente.example',
    description:
      'Correo del miembro de tu organización cuyos documentos quieres ver. No distingue mayúsculas.',
  })
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  @MaxLength(320)
  email: string;
}

/**
 * Query de `GET /integration/documents`: la del listado más un filtro opcional por el correo del
 * creador. Con `creatorEmail`, la llave puede tener `DOCUMENT.READ` con alcance `OWN` (sólo su
 * propio correo) u `ORGANIZATION`; sin él, sólo `ORGANIZATION`.
 */
export class ListIntegrationDocumentsByCreatorQueryDto extends ListIntegrationDocumentsQueryDto {
  @ApiPropertyOptional({
    example: 'ana.lopez@cliente.example',
    description:
      'Opcional. Sólo los documentos que creó el miembro de tu organización con este correo.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'creatorEmail debe ser un correo válido' })
  @MaxLength(320)
  creatorEmail?: string;
}
