import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UpdateUserDto } from '../dto/update-user.dto';
import { UserService } from '../user.service';
import { GetUserUseCase } from './get-user.use-case';

/**
 * `PATCH /user/:id`: edición de nombre, apellido, correo y roles desde la API con llave.
 *
 * El perfil se relee después de escribir, en vez de devolver el DTO recibido: así la respuesta
 * refleja lo que quedó guardado —con la normalización ya aplicada— y no lo que el cliente
 * mandó.
 */
@Injectable()
export class UpdateUserUseCase {
  constructor(
    private readonly userService: UserService,
    private readonly getUser: GetUserUseCase,
  ) {}

  async execute(
    id: string,
    updateUserDto: UpdateUserDto,
  ): Promise<BaseResponse<any>> {
    await this.userService.applyUserUpdate(id, updateUserDto);

    return {
      success: true,
      message: 'Usuario actualizado correctamente',
      data: await this.getUser.execute(id),
    };
  }
}
