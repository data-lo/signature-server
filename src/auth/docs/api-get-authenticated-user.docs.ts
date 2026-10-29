import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UserGetResponse } from 'src/user/interfaces/response/get-user-response';
import { UnauthorizedResponse } from 'src/interfaces/api-response.dto';

/**
 * `GET /auth/me` — datos del usuario autenticado.
 *
 * Es el único endpoint de este controlador que declara `ApiBearerAuth`: `AuthController` no lo
 * pone a nivel de clase porque casi todas sus rutas son públicas (`@SkipJwtAuth`).
 */
export function ApiGetAuthenticatedUser() {
  return applyDecorators(
    ApiBearerAuth('access-token'),
    ApiOperation({ summary: 'Obtener los datos del usuario autenticado' }),
    ApiResponse({ status: 200, type: UserGetResponse }),
    ApiResponse({ status: 401, type: UnauthorizedResponse }),
  );
}
