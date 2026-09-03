import { Injectable, UnauthorizedException } from '@nestjs/common';

import { AccountService } from 'src/account/account.service';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { PasswordService } from 'src/shared/password/password.service';

import { ChangeMyPasswordDto } from '../dto/change-my-password.dto';
import { UserService } from '../user.service';

/**
 * Cambia la propia contraseña desde la pantalla de configuración, acreditándose con la actual
 * (`PUT /api/v1/users/me/password`).
 *
 * Es el hermano con sesión de `ResetPasswordUseCase`: escribe en los mismos dos lugares
 * —`User.password` y su copia sincronizada en cada `Account`, contra la que resuelve el login—
 * porque actualizar sólo una dejaría al usuario sin poder entrar con ninguna de las dos.
 *
 * A diferencia del reset, NO invalida las sesiones: quien cambia su contraseña acá está usando una, y
 * expulsarlo lo dejaría fuera en el mismo momento en que la pantalla le confirma el cambio. El reset
 * puede permitírselo justamente porque ocurre sin sesión.
 */
@Injectable()
export class ChangeMyPasswordUseCase {
  constructor(
    private readonly userService: UserService,
    private readonly accountService: AccountService,
    private readonly passwordService: PasswordService,
  ) {}

  async execute(
    userId: string,
    dto: ChangeMyPasswordDto,
  ): Promise<BaseResponse<null>> {
    // `findOne` rechaza al usuario inexistente o inactivo con un Error genérico; acá eso es un
    // 401 y no un 500: el JWT es válido pero ya no acredita a nadie que pueda operar.
    const user = await this.userService.findOne(userId).catch(() => null);
    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const matches = await this.passwordService.compare(
      dto.currentPassword,
      user.password,
    );
    if (!matches) {
      throw new UnauthorizedException('La contraseña actual no es correcta');
    }

    const hashedPassword = await this.passwordService.hash(dto.newPassword);

    await this.userService.updatePassword(userId, hashedPassword);
    await this.accountService.updatePasswordForUser(userId, hashedPassword);

    return {
      success: true,
      message: 'Contraseña actualizada correctamente',
      data: null,
    };
  }
}
