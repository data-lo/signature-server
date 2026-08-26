import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { CreateUserDto } from '../dto/create-user.dto';
import { UserEntity } from '../entities/user.entity';
import { UserService } from '../user.service';

/**
 * `POST /user`: alta de un usuario desde la API con llave (`@Public`), no desde el registro
 * público — ese es `RegisterUseCase`, que además pide CAPTCHA, contraseña y verificación de
 * correo. Acá el llamante ya está autorizado por la llave de API y crea la ficha directamente.
 *
 * Las tres unicidades se comprueban antes de abrir la transacción: correo siempre, CURP y RFC
 * sólo si vienen. Adelantarlas evita empezar una transacción que se sabe condenada, y sobre
 * todo hace que el cliente reciba un 409 explicando qué campo choca en vez del error de
 * restricción única de PostgreSQL.
 */
@Injectable()
export class CreateUserUseCase {
  constructor(private readonly userService: UserService) {}

  async execute(
    createUserDto: CreateUserDto,
  ): Promise<BaseResponse<UserEntity>> {
    await this.userService.assertEmailNotTaken(createUserDto.email);

    if (createUserDto.nationalId) {
      await this.userService.assertCurpNotTaken(
        createUserDto.nationalId.toUpperCase(),
      );
    }
    if (createUserDto.rfc) {
      await this.userService.assertRfcNotTaken(createUserDto.rfc.toUpperCase());
    }

    const newUser = await this.userService.saveNewUser(createUserDto);

    return {
      success: true,
      message: 'Usuario creado correctamente',
      data: this.userService.sanitize(newUser),
    };
  }
}
