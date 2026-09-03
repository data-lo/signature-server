import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { CreateUserDto } from '../dto/create-user.dto';
import { UserEntity } from '../entities/user.entity';
import { UserService } from '../user.service';

/**
 * Da de alta un usuario desde la API con llave (`POST /user`, `@Public`), no desde el registro
 * público —ése es `RegisterUseCase`, que además pide CAPTCHA, contraseña y verificación de correo—:
 * acá el llamante ya está autorizado por la llave de API y crea la ficha directamente.
 *
 * Comprueba las tres unicidades antes de abrir la transacción —correo siempre, CURP y RFC sólo si
 * vienen— para no empezar una transacción condenada y, sobre todo, para que el cliente reciba un 409
 * explicando qué campo choca en vez del error de restricción única de PostgreSQL.
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
