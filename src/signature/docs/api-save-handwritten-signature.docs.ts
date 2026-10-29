import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { SaveHandwrittenSignatureDto } from '../dto/save-handwritten-signature.dto';

/**
 * `POST /api/v1/signature-capture-sessions/:id/signature`
 *
 * `ApiConsumes`/`ApiBody` describen el multipart; el `FileInterceptor` que de verdad lo procesa
 * (y su límite de tamaño) se queda en el controlador: es comportamiento, no documentación.
 */
export function ApiSaveHandwrittenSignature() {
  return applyDecorators(
    ApiOperation({
      summary: 'Guardar la firma manuscrita capturada',
      description:
        'Recibe el PNG que exportó el canvas, lo almacena, lo enlaza como firma vigente del usuario (users.signatureId) y deja la credencial en CONFIGURED. La captura queda COMPLETED con el archivo que produjo. El canal MOBILE_QR exige haber reclamado la sesión antes; el DESKTOP no. El archivo viaja como multipart y se valida por sus bytes: sólo se acepta PNG, y nunca Base64 en JSON.',
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({ type: SaveHandwrittenSignatureDto }),
    ApiResponse({
      status: 201,
      description: 'Firma registrada y captura completada.',
    }),
    ApiResponse({
      status: 400,
      description: 'No llegó ningún archivo, o lo recibido no es un PNG.',
    }),
    ApiResponse({
      status: 403,
      description:
        'La captura pertenece a otro usuario, o el usuario no tiene la identidad aprobada.',
    }),
    ApiResponse({ status: 404, description: 'La captura no existe.' }),
    ApiResponse({
      status: 409,
      description:
        'La captura ya se completó, se canceló, venció, o todavía no se reclamó desde el teléfono.',
    }),
  );
}
