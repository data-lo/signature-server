import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';
import { StartBiometricSignatureDto } from '../dto/start-biometric-signature.dto';

const DOCUMENT_PARAM = ApiParam({
  name: 'documentId',
  description: 'UUID del documento',
  format: 'uuid',
});

/**
 * `POST /documents/:documentId/biometric-signature/session` — firmante con cuenta.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @Post('session')
 * @ApiStartAccountBiometricSession()
 * start() {}
 * ```
 */
export function ApiStartAccountBiometricSession() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Iniciar la firma biométrica del firmante autenticado (Biometric Authentication de ' +
        'Didit contra su identidad aprobada). Devuelve la URL de Didit; si ya hay una sesión ' +
        'abierta y vigente sobre el mismo PDF, devuelve esa misma. No firma: la firma se ' +
        'registra cuando Didit aprueba por webhook.',
    }),
    DOCUMENT_PARAM,
    ApiBody({ type: StartBiometricSignatureDto, required: true }),
    ApiResponse({
      status: 201,
      description:
        'Sesión lista: `url` es la página de Didit, `reused` indica si ya existía.',
    }),
    ApiResponse({
      status: 400,
      description:
        'Falta la ubicación o el consentimiento, el documento no está pendiente, ya respondiste, ' +
        'tu firma no es biométrica o falta el código de verificación',
      type: BadRequestResponse,
    }),
    ApiResponse({
      status: 403,
      description:
        'No eres firmante, no es tu turno o no tienes identidad Didit aprobada',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
    ApiResponse({
      status: 422,
      description:
        'Tu identidad aprobada no tiene una imagen de rostro utilizable',
    }),
    ApiResponse({ status: 502, description: 'Didit no pudo crear la sesión' }),
  );
}

/**
 * `GET /documents/:documentId/biometric-signature/session` — estado para el firmante con cuenta.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @Get('session')
 * @ApiGetAccountBiometricSession()
 * status() {}
 * ```
 */
export function ApiGetAccountBiometricSession() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Estado del último intento biométrico del firmante autenticado. `null` si nunca inició ' +
        'uno. Nunca incluye el veredicto biométrico.',
    }),
    DOCUMENT_PARAM,
    ApiResponse({ status: 200, description: 'Estado del último intento' }),
    ApiResponse({ status: 403, description: 'No eres firmante del documento' }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
