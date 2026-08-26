import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UserService } from '../user.service';

/**
 * `GET /api/v1/users/check-rfc`: dice si un RFC ya tiene cuenta.
 *
 * Es público (sin JWT) y lo consumen `/join` y `/signup` de signature-app para bifurcar el flujo
 * de invitación a una organización (ver historia [STORY] Eventos Kafka, Email (SendGrid) y
 * Miembros (/join)): si el RFC ya existe, al usuario se le ofrece "unirse con su cuenta"; si no,
 * se le manda a registrarse.
 *
 * Sólo devuelve un booleano, nunca a quién pertenece: el RFC de una empresa es público y no
 * debería servir para averiguar el correo ni el nombre de quien ya está registrado.
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
