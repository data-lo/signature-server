import { Controller, Get, Headers } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from 'src/auth/decorators/current-user.decorator';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

import { GetAuthorizationContextUseCase } from './applications/get-authorization-context.use-case';
import { ApiGetAuthorizationContext } from './docs/api-get-authorization-context.docs';

@ApiTags('Authorization')
@ApiBearerAuth('access-token')
@Controller('authorization')
export class AuthorizationController {
  constructor(
    private readonly getAuthorizationContext: GetAuthorizationContextUseCase,
  ) {}

  /**
   * La cuenta activa llega por header y nunca por query: es contexto de la sesión, no un
   * parámetro de la consulta, y en la URL acabaría en logs y en el historial del navegador.
   *
   * Se aceptan dos nombres. `X-Active-Account-Id` es el que nombra la historia y el que manda el
   * servidor de Next al renderizar el dashboard; `X-Account-Id` es el que ya inyecta el
   * interceptor del navegador en cada petición. Admitir los dos evita que el cliente tenga que
   * mandar el mismo dato con dos nombres según desde dónde llame.
   */
  @Get('context')
  @ApiGetAuthorizationContext()
  context(
    @CurrentUser() user: JwtPayload,
    @Headers('x-active-account-id') activeAccountId?: string,
    @Headers('x-account-id') fallbackAccountId?: string,
  ) {
    return this.getAuthorizationContext.execute(
      user.sub,
      activeAccountId ?? fallbackAccountId,
    );
  }
}
