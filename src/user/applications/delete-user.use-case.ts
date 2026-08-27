import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UserService } from '../user.service';

/**
 * `DELETE /user/:id`: da de baja a un usuario.
 *
 * La baja es lógica (`isActive=false`, `isDeleted=true`) y no un borrado real: el id del
 * usuario queda referenciado desde los documentos que firmó y desde sus filas de colaborador,
 * así que eliminarlo de verdad dejaría firmas pasadas sin poder atribuirse a nadie.
 */
@Injectable()
export class DeleteUserUseCase {
  constructor(private readonly userService: UserService) {}

  async execute(id: string): Promise<BaseResponse> {
    await this.userService.softDelete(id);

    return {
      success: true,
      message: 'Usuario eliminado correctamente',
    };
  }
}
