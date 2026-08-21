import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { AdvancedSignaturePublicViewResponse } from '../interfaces/responses/advanced-signature-public-view-response';
import { NotFoundResponse } from 'src/interfaces/api-response.dto';

/** `GET /document/public/:id/signatures/:collaboratorId` — destino del QR de una firma avanzada. */
export function ApiGetPublicAdvancedSignature() {
  return applyDecorators(
    ApiOperation({
      summary: 'Constancia pública de una firma avanzada (sin autenticación)',
      description:
        'Público (sin JWT ni x-api-key, ver SkipJwtAuth) — es el destino del código QR que se estampa en el documento por cada firma avanzada (historia "Generar código QR para firmas avanzadas"). Devuelve quién firmó y cuándo. Responde 404 si el colaborador no pertenece al documento, si su firma es simple o si todavía no ha firmado: mientras la firma avanzada esté pendiente no hay constancia que consultar.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiParam({
      name: 'collaboratorId',
      description: 'UUID del colaborador firmante',
      format: 'uuid',
    }),
    ApiResponse({
      status: 200,
      description: 'Firma obtenida correctamente',
      type: AdvancedSignaturePublicViewResponse,
    }),
    ApiResponse({
      status: 404,
      description: 'Firma avanzada no encontrada, o todavía pendiente',
      type: NotFoundResponse,
    }),
  );
}
