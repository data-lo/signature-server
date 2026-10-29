import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';

import { RejectDocumentApprovalDto } from '../dto/reject-document-approval.dto';

/** `POST /api/v1/documents/:documentId/approval/reject` — el reviewer niega la autorización. */
export function ApiRejectDocumentApproval() {
  return applyDecorators(
    ApiOperation({
      summary: 'Rechazar la aprobación de un documento',
      description:
        'Solo el usuario aprobador asignado, y solo mientras el documento esté en PENDING_APPROVAL y su decisión siga pendiente. El documento queda en REJECTED y el flujo de firma no llega a empezar: los firmantes no son notificados, porque con la aprobación pendiente nunca lo fueron. Se avisa al creador con el motivo, si se envió.',
    }),
    ApiBody({ type: RejectDocumentApprovalDto, required: false }),
    ApiResponse({
      status: 201,
      description: 'Aprobación rechazada; el documento queda en REJECTED',
    }),
    ApiResponse({
      status: 400,
      description:
        'El documento no requiere aprobación, no está en PENDING_APPROVAL, o su aprobador ya registró una decisión',
    }),
    ApiResponse({
      status: 403,
      description: 'Quien llama no es el usuario aprobador asignado',
    }),
    ApiResponse({
      status: 404,
      description: 'El documento no existe o no tiene aprobador asignado',
    }),
  );
}
