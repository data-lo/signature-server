import { Injectable } from '@nestjs/common';

import { GetUserUseCase } from 'src/user/applications/get-user.use-case';

import { JwtPayload } from '../interfaces/jwt-payload.interface';

/**
 * Devuelve el perfil de quien está autenticado (`GET /auth/me`), resuelto desde el `sub` del JWT y
 * nunca desde un parámetro de la petición.
 *
 * Relee de la base en vez de devolver lo que trae el token: el JWT es una foto del momento en que se
 * emitió, y desde entonces el usuario pudo cambiar datos, completar el onboarding o quedar
 * desactivado.
 *
 * El perfil lo arma `GetUserUseCase`, el mismo de `GET /user/:id`: no es otra vista, es esa consulta
 * con el identificador tomado del token.
 */
@Injectable()
export class GetAuthenticatedUserUseCase {
  constructor(private readonly getUser: GetUserUseCase) {}

  async execute(payload: JwtPayload) {
    return this.getUser.execute(payload.sub, true);
  }
}
