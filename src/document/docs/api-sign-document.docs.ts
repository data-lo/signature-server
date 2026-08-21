import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { SignDocumentDto } from '../dto/sign-document.dto';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';

/**
 * `PATCH /document/:id/sign` — firma del documento en el turno del firmante.
 *
 * `ApiConsumes`/`ApiBody` describen el multipart de la e.firma (.key/.cer); el
 * `FileFieldsInterceptor` que lo procesa se queda en el controlador, porque es comportamiento.
 */
export function ApiSignDocument() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Firmar el documento (solo si es tu turno como firmante). La geolocalización es ' +
        'obligatoria. Para firma electrónica avanzada (FIEL) requiere además .key/.cer y ' +
        'contraseña como multipart/form-data.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiConsumes('multipart/form-data'),
    ApiBody({ type: SignDocumentDto, required: true }),
    ApiResponse({
      status: 200,
      description: 'Documento firmado correctamente',
    }),
    ApiResponse({
      status: 400,
      description:
        'Falta la geolocalización (obligatoria para firmar), el documento no se encuentra en ' +
        'estatus PENDING, ya respondiste, o faltan/son inválidos los archivos .key/.cer ' +
        'requeridos para firma FIEL',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'No eres firmante de este documento o no es tu turno',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
    ApiResponse({
      status: 422,
      description:
        'La e.firma no pudo validarse: contraseña incorrecta, certificado inválido/expirado, o la ' +
        'llave privada no corresponde al certificado',
    }),
  );
}
