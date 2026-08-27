import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { AuthService } from '../auth.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

/**
 * `POST /auth/logout`: cierra la sesión con la que se llamó al endpoint.
 *
 * Sólo esa: las demás sesiones del mismo usuario siguen vivas, porque cerrar sesión en un
 * dispositivo no es motivo para echar a la persona de los otros. La expulsión en bloque existe
 * aparte y la dispara el cambio de contraseña.
 */
@Injectable()
export class LogoutUseCase {
  constructor(private readonly authService: AuthService) {}

  async execute(payload: JwtPayload): Promise<BaseResponse<null>> {
    await this.authService.blacklistJwt(payload);

    return {
      success: true,
      message: 'Sesión cerrada correctamente',
      data: null,
    };
  }
}
