import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UserEntity } from '../entities/user.entity';
import { UserService } from '../user.service';

/**
 * `GET /user`: listado de usuarios activos.
 *
 * Una lista vacía no es un error: se responde con `success: true` y un mensaje distinto, porque
 * "todavía no hay nadie registrado" es un estado legítimo del sistema y no algo que el cliente
 * deba manejar como fallo.
 */
@Injectable()
export class ListUsersUseCase {
  constructor(private readonly userService: UserService) {}

  async execute(withSignature = false): Promise<BaseResponse<UserEntity[]>> {
    const users = await this.userService.listActiveUsers(withSignature);

    return {
      success: true,
      message: users.length
        ? 'Usuarios obtenidos correctamente'
        : 'No hay usuarios registrados',
      data: users,
    };
  }
}
