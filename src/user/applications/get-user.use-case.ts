import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UserEntity } from '../entities/user.entity';
import { UserService } from '../user.service';

/**
 * `GET /user/:id`: perfil de un usuario activo, con la información personal aplanada y —si se
 * piden con `withSignature`— las URLs prefirmadas de su firma y su credencial oficial.
 *
 * `GET /auth/me` responde exactamente esto mismo para el usuario del token, y por eso delega
 * acá en vez de repetir la forma de la respuesta: si mañana el perfil gana un campo, los dos
 * endpoints lo ganan juntos.
 */
@Injectable()
export class GetUserUseCase {
  constructor(private readonly userService: UserService) {}

  async execute(
    id: string,
    withSignature = false,
  ): Promise<BaseResponse<UserEntity | null>> {
    return {
      success: true,
      message: 'Usuario obtenido correctamente',
      data: await this.userService.getActiveUserProfile(id, withSignature),
    };
  }
}
