import { applyDecorators } from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentGetListResponse } from '../interfaces/responses/document-get-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/** `GET /document` — listado paginado con filtros, restringido a la cuenta activa. */
export function ApiGetDocuments() {
  return applyDecorators(
    ApiOperation({ summary: 'Consultar documentos con filtros opcionales' }),
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la cuenta activa (personal u organización). El listado se restringe a los documentos de esa cuenta; el usuario debe ser miembro activo.',
      required: true,
    }),
    ApiQuery({
      name: 'id',
      required: false,
      description: 'UUID del documento',
      format: 'uuid',
    }),
    ApiQuery({
      name: 'participantEmail',
      required: false,
      description: 'Email de un participante (firmante o espectador)',
    }),
    ApiQuery({
      name: 'email',
      required: false,
      description: 'Email del propietario o de cualquier participante',
    }),
    ApiQuery({
      name: 'status',
      required: false,
      enum: DOCUMENT_STATUS_ENUM,
      description: 'Estatus del documento',
    }),
    ApiQuery({
      name: 'dateFrom',
      required: false,
      description: 'Fecha de creación inicio (ISO 8601)',
      example: '2024-01-01',
    }),
    ApiQuery({
      name: 'dateTo',
      required: false,
      description: 'Fecha de creación fin (ISO 8601)',
      example: '2024-12-31',
    }),
    ApiQuery({
      name: 'signedDateFrom',
      required: false,
      description: 'Fecha de firma inicio (ISO 8601)',
      example: '2024-01-01',
    }),
    ApiQuery({
      name: 'signedDateTo',
      required: false,
      description: 'Fecha de firma fin (ISO 8601)',
      example: '2024-12-31',
    }),
    ApiQuery({
      name: 'fileName',
      required: false,
      description: 'Búsqueda parcial por nombre de archivo',
    }),
    ApiQuery({
      name: 'participantName',
      required: false,
      description:
        'Búsqueda parcial por nombre o correo de un firmante/espectador',
    }),
    ApiQuery({
      name: 'myTurnOnly',
      required: false,
      description:
        'Requiere participantEmail. Solo documentos donde te toca firmar ahora mismo',
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
      description: 'Resultados por página',
      example: 10,
    }),
    ApiResponse({
      status: 200,
      description: 'Lista de documentos',
      type: DocumentGetListResponse,
    }),
    ApiResponse({
      status: 400,
      description: 'Parámetros inválidos',
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
