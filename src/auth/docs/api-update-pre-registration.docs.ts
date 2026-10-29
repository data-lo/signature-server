import { applyDecorators } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UpdatePreRegistrationResponse } from '../interfaces/response/auth-response';
import {
  ConflictResponse,
  UnauthorizedResponse,
} from 'src/interfaces/api-response.dto';

/** `PATCH /auth/pre-registration` — corrige un registro que aún no verifica su correo. */
export function ApiUpdatePreRegistration() {
  return applyDecorators(
    ApiOperation({
      summary:
        'Corrige los datos de un registro que aún no verifica su correo (público, autorizado con la contraseña del propio registro)',
      description:
        'Pensado para el error de dedo en el correo, que dejaba la cuenta imposible de activar: el código se enviaba a una dirección inexistente y volver a registrarse tampoco servía, porque el CURP ya estaba tomado por ese mismo pre-registro. Si el correo cambia, se emite y envía un código nuevo a la dirección corregida.',
    }),
    ApiResponse({ status: 200, type: UpdatePreRegistrationResponse }),
    ApiResponse({
      status: 401,
      type: UnauthorizedResponse,
      description:
        'No hay un registro pendiente con ese correo, o la contraseña no coincide (mismo mensaje en ambos casos, anti-enumeración)',
    }),
    ApiResponse({
      status: 409,
      type: ConflictResponse,
      description:
        'El correo ya fue verificado, o el nuevo correo/CURP/RFC ya pertenece a otro usuario',
    }),
  );
}
