import { applyDecorators } from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DOCUMENT_VIEW_ENUM } from '../enum/document-view.enum';
import {
  DOCUMENT_SORT_FIELD_ENUM,
  SORT_DIRECTION_ENUM,
} from '../enum/document-sort-field.enum';
import { DocumentsListResponse } from '../interfaces/responses/document-get-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/**
 * `GET /document` — el ÚNICO listado de documentos, paginado y con filtros.
 *
 * Sustituye a las tres consultas que armaban las pantallas segmentadas. Los parámetros de
 * aquéllas (`participantEmail`, `email`, `status`, `fileName`, `participantName`, `myTurnOnly`)
 * ya no existen: describían cómo consultar, y `view`/`search`/`participant`/`statuses` describen
 * qué se quiere ver.
 */
export function ApiGetDocuments() {
  return applyDecorators(
    ApiOperation({
      summary: 'Listado unificado de documentos',
      description:
        'Devuelve los documentos visibles para el usuario en la cuenta activa: los de la cuenta ' +
        'u organización, los que creó y aquellos en los que participa. `view` recorta ese ' +
        'conjunto, nunca lo amplía. Excluye los que el propio usuario archivó.',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la cuenta activa (personal u organización). El usuario debe ser miembro activo. Nunca se acepta como parámetro de query.',
      required: true,
    }),
    ApiQuery({
      name: 'view',
      required: false,
      enum: DOCUMENT_VIEW_ENUM,
      description:
        'Recorte principal. Por omisión `requires_my_signature`: lo que espera una acción del usuario.',
    }),
    ApiQuery({
      name: 'search',
      required: false,
      description:
        'Búsqueda libre por nombre del documento o por nombre/correo de cualquier participante',
    }),
    ApiQuery({
      name: 'statuses',
      required: false,
      isArray: true,
      enum: DOCUMENT_STATUS_ENUM,
      description:
        'Uno o varios estatus. Repetible (`?statuses=pending&statuses=signed`) o separado por comas',
    }),
    ApiQuery({
      name: 'participant',
      required: false,
      description: 'Nombre o correo de un participante del documento',
    }),
    ApiQuery({
      name: 'createdFrom',
      required: false,
      description: 'Creados desde (ISO 8601)',
      example: '2026-01-01',
    }),
    ApiQuery({
      name: 'createdTo',
      required: false,
      description: 'Creados hasta (ISO 8601)',
      example: '2026-12-31',
    }),
    ApiQuery({
      name: 'signedFrom',
      required: false,
      description: 'Firmados desde (ISO 8601)',
      example: '2026-01-01',
    }),
    ApiQuery({
      name: 'signedTo',
      required: false,
      description: 'Firmados hasta (ISO 8601)',
      example: '2026-12-31',
    }),
    ApiQuery({
      name: 'sortBy',
      required: false,
      enum: DOCUMENT_SORT_FIELD_ENUM,
      description:
        'Campo de ordenamiento (lista cerrada). Por omisión `createdAt`',
    }),
    ApiQuery({
      name: 'sortDirection',
      required: false,
      enum: SORT_DIRECTION_ENUM,
      description: 'Dirección del ordenamiento. Por omisión `DESC`',
    }),
    ApiQuery({
      name: 'page',
      required: false,
      description: 'Página',
      example: 1,
    }),
    ApiQuery({
      name: 'limit',
      required: false,
      description: 'Resultados por página (máximo 100)',
      example: 25,
    }),
    ApiQuery({
      name: 'id',
      required: false,
      description:
        'UUID de un documento concreto, para comprobar si entra en el listado con estos filtros',
      format: 'uuid',
    }),
    ApiQuery({
      name: 'withUrl',
      required: false,
      description:
        'Incluir la URL prefirmada de cada documento (una llamada a MinIO por resultado)',
    }),
    ApiResponse({
      status: 200,
      description: 'Documentos de la página, con su paginación',
      type: DocumentsListResponse,
    }),
    ApiResponse({
      status: 400,
      description:
        'Parámetros inválidos, falta el header X-Account-Id, o un rango de fechas está invertido',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'No perteneces a la cuenta activa (X-Account-Id)',
    }),
  );
}
