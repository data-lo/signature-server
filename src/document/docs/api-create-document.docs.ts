import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CreateDocumentDto } from '../dto/create-document.dto';
import { DocumentCreateResponse } from '../interfaces/responses/document-create-response';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/**
 * `POST /document` — alta de un documento para firmar.
 *
 * `ApiConsumes`/`ApiBody` describen el multipart; el `FileInterceptor` que lo procesa se queda en
 * el controlador, porque es comportamiento.
 */
export function ApiCreateDocument() {
  return applyDecorators(
    ApiOperation({ summary: 'Registrar nuevo documento para firmar' }),
    ApiHeader({
      name: 'X-Account-Id',
      description:
        'UUID de la cuenta activa (personal u organización). El documento queda scopeado a esa cuenta; el usuario debe ser miembro activo.',
      required: true,
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({ type: CreateDocumentDto }),
    ApiResponse({
      status: 201,
      description:
        'Documento subido y registrado exitosamente en el sistema, pendiente de firma',
      type: DocumentCreateResponse,
    }),
    ApiResponse({
      status: 400,
      description:
        'Datos de entrada inválidos, formato de archivo no soportado o documento no proporcionado',
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
    ApiResponse({
      status: 404,
      description:
        'Algún firmante o espectador especificado no existe en el sistema',
      type: NotFoundResponse,
    }),
  );
}
