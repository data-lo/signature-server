import { Injectable, NotFoundException } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { UpdatePersonalInformationDto } from '../dto/update-personal-information.dto';
import { PersonalInformationEntity } from '../entities/personal-information.entity';
import { UserService } from '../user.service';

/**
 * `PUT /api/v1/users/me/personal-information`: teléfono y correo secundario del usuario.
 *
 * El refresco del cache por CURP es parte de la operación y no un detalle aparte: estos campos
 * viajan dentro del snapshot que sirve `GET /users/me`, así que sin ese paso el usuario vería
 * sus datos viejos hasta que la key venciera, y creería que el guardado no funcionó.
 */
@Injectable()
export class UpdateMyPersonalInformationUseCase {
  constructor(private readonly userService: UserService) {}

  async execute(
    userId: string,
    dto: UpdatePersonalInformationDto,
  ): Promise<BaseResponse<PersonalInformationEntity>> {
    const user = await this.userService.findOneWithPersonalInformation(userId);
    if (!user) {
      throw new NotFoundException(`Usuario con ID ${userId} no encontrado`);
    }

    const updated = await this.userService.savePersonalInformation(
      user.personalInformationId,
      dto,
    );

    await this.userService.refreshCurpCache(user, updated);

    return {
      success: true,
      message: 'Información personal actualizada correctamente',
      data: updated,
    };
  }
}
