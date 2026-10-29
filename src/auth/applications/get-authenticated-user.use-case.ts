import { Injectable } from '@nestjs/common';

import { GetUserUseCase } from 'src/user/applications/get-user.use-case';

import { JwtPayload } from '../interfaces/jwt-payload.interface';

/**
 * `GET /auth/me`: el perfil de quien está autenticado, resuelto desde el `sub` del JWT y nunca
 * desde un parámetro de la petición.
 *
 * Se relee de la base en vez de devolver lo que trae el token: el JWT es una foto del momento
 * en que se emitió, y entre ese momento y ahora el usuario pudo cambiar sus datos, completar el
 * onboarding o quedar desactivado.
 *
 * El perfil lo arma `GetUserUseCase`, el mismo que atiende `GET /user/:id`: este endpoint no es
 * otra vista, es esa misma consulta con el identificador tomado del token en lugar de la ruta.
 */
@Injectable()
export class GetAuthenticatedUserUseCase {
  constructor(private readonly getUser: GetUserUseCase) {}

  async execute(payload: JwtPayload) {
    return this.getUser.execute(payload.sub, true);
  }
}
