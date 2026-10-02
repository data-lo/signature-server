import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import {
  BadRequestResponse,
  NotFoundResponse,
} from 'src/interfaces/api-response.dto';
import { StartBiometricSignatureDto } from '../dto/start-biometric-signature.dto';

/**
 * `POST /document/:id/biometric-signature` — inicia o retoma la sesión de Didit con la que el
 * firmante autoriza su firma biométrica.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @Post(':id/biometric-signature')
 * @ApiStartBiometricSignature()
 * start() {}
 * ```
 */
export function ApiStartBiometricSignature() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Iniciar la firma biométrica (prueba de vida + face match con Didit). Devuelve la URL ' +
        'de Didit; si ya hay una sesión abierta y vigente sobre el mismo PDF, devuelve esa misma ' +
        'en vez de crear otra. No firma: la firma se registra cuando Didit aprueba por webhook.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiBody({ type: StartBiometricSignatureDto, required: true }),
    ApiResponse({
      status: 201,
      description:
        'Sesión biométrica lista: `url` es la página de Didit (para abrir o convertir en QR), ' +
        '`reused` indica si es una sesión que ya existía.',
    }),
    ApiResponse({
      status: 400,
      description:
        'Falta la geolocalización, el documento no está pendiente de firma, ya respondiste, tu ' +
        'firma no es biométrica o falta validar el código que el documento exige',
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
      status: 409,
      description:
        'Otra petición está abriendo una sesión para esta misma firma',
    }),
    ApiResponse({
      status: 502,
      description: 'Didit no pudo crear la sesión',
    }),
  );
}

/**
 * `GET /document/:id/biometric-signature` — estado del último intento biométrico del firmante.
 *
 * @returns Los decoradores de Swagger del endpoint.
 *
 * @example
 * ```ts
 * @Get(':id/biometric-signature')
 * @ApiGetBiometricSignatureStatus()
 * status() {}
 * ```
 */
export function ApiGetBiometricSignatureStatus() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Consultar la firma biométrica del usuario sobre el documento. Devuelve `null` si nunca ' +
        'inició una. `url` sólo viene mientras la sesión sigue abierta; `signatureCompleted` ' +
        'indica que la firma ya quedó registrada y `documentCompleted`, que con ella el ' +
        'documento quedó firmado por todos.',
    }),
    ApiParam({ name: 'id', description: 'UUID del documento', format: 'uuid' }),
    ApiResponse({ status: 200, description: 'Estado del último intento' }),
    ApiResponse({
      status: 401,
      description:
        'Token de autenticación inválido, expirado o no proporcionado',
    }),
    ApiResponse({
      status: 403,
      description: 'No eres firmante de este documento',
    }),
    ApiResponse({
      status: 404,
      description: 'Documento no encontrado',
      type: NotFoundResponse,
    }),
  );
}
