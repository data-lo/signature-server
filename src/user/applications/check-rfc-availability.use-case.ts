import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UserService } from '../user.service';

/**
 * Responde si un RFC ya tiene cuenta (`GET /api/v1/users/check-rfc`).
 *
 * Es público y lo consumen `/join` y `/signup` para bifurcar el flujo de invitación: si el RFC ya
 * existe se ofrece "unirse con su cuenta", y si no, registrarse.
 *
 * Devuelve sólo un booleano y nunca a quién pertenece: el RFC de una empresa es público y no debería
 * servir para averiguar el correo ni el nombre de quien ya está registrado.
 */
@Injectable()
export class CheckRfcAvailabilityUseCase {
  constructor(private readonly userService: UserService) {}

  async execute(rfc: string): Promise<BaseResponse<{ exists: boolean }>> {
    return {
      success: true,
      message: 'Disponibilidad del RFC consultada correctamente',
      data: { exists: await this.userService.isRfcRegistered(rfc) },
    };
  }
}
