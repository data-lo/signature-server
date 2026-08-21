import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CreateDocumentSignaturesDto } from '../dto/create-document-signatures.dto';
import { DocumentSignaturesCreateResponse } from '../interfaces/responses/document-signatures-create-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/**
 * `POST /api/v1/documents/signatures` — alta transaccional del flujo de firmas.
 *
 * `ApiConsumes`/`ApiBody` describen el multipart; el `FileInterceptor` que de verdad lo procesa
 * —con su límite de tamaño y el `defParamCharset` que evita el mojibake en los nombres con
 * acento— se queda en el controlador, porque es comportamiento y no documentación.
 */
export function ApiCreateDocumentSignatureFlow() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Sube el documento y orquesta la creación transaccional de su flujo de firmas (Document, Collaborator, Notification, verification_code); publica un evento de Kafka por notificación',
    }),
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la cuenta activa (personal u organización). El documento queda scopeado a esa cuenta; el usuario debe ser miembro activo.',
      required: true,
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({ type: CreateDocumentSignaturesDto }),
    ApiResponse({
      status: 201,
      description:
        'Documento, colaboradores, notificaciones y códigos de verificación creados; eventos publicados en Kafka',
      type: DocumentSignaturesCreateResponse,
    }),
    ApiResponse({
      status: 400,
      description:
        'Payload inválido, archivo no proporcionado, tipo de firma del documento ausente o distinto de SIMPLE/ADVANCED, documento sin ningún SIGNER, o colaborador VIEWER sin rfc',
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
