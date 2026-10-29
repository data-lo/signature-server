import { applyDecorators } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CreateSignatureDto } from 'src/signature/dto/create-signature.dto';
import { SignatureCreateResponse } from 'src/signature/interfaces/signature-create-response';
import { BadRequestResponse } from 'src/interfaces/api-response.dto';

/**
 * `PUT /api/v1/users/me/signature` — alta de la rúbrica del usuario autenticado.
 *
 * `ApiConsumes`/`ApiBody` describen el multipart; el `FileFieldsInterceptor` que de verdad lo
 * procesa (y su límite de tamaño) se queda en el controlador: es comportamiento, no documentación.
 */
export function ApiRegisterMySignature() {
  return applyDecorators(
    ApiOperation({
      summary: 'Registrar la firma digital del usuario autenticado',
      description:
        'Recibe la imagen PNG de la firma (y opcionalmente la identificación oficial), la almacena y vincula el signatureId en el usuario. Sólo se acepta con la credencial en SIGNATURE_PENDING (identidad ya aprobada y sin firma registrada); al completarse, el usuario queda en CONFIGURED.',
    }),
    ApiConsumes('multipart/form-data'),
    ApiBody({ type: CreateSignatureDto }),
    ApiResponse({
      status: 201,
      description: 'Firma registrada y asignada al usuario correctamente',
      type: SignatureCreateResponse,
    }),
    ApiResponse({
      status: 400,
      description: 'Datos inválidos o imagen de firma no proporcionada',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description:
        'La credencial de firma no está en SIGNATURE_PENDING: falta validar la identidad, sigue en curso, está bloqueada o ya hay una firma registrada',
    }),
  );
}
