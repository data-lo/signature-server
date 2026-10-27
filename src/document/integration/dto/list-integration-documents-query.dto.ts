import { PickType } from '@nestjs/swagger';

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
