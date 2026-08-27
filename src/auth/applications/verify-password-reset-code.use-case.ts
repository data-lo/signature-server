import { BadRequestException, Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { UserService } from 'src/user/user.service';

import { AuthService } from '../auth.service';
import { VerifyResetCodeDto } from '../dto/verify-reset-code.dto';
import { PasswordResetCodeService } from '../password-reset-code.service';

/**
 * `POST /auth/verify-reset-code`: canjea el OTP de recuperación por un `resetToken` de corta
 * vida, que es lo que después autoriza el cambio de contraseña.
 *
 * No distingue "no existe el usuario" de "código inválido o expirado": mismo error en ambos
 * casos, para no filtrar existencia de cuentas en este paso tampoco.
 */
@Injectable()
export class VerifyPasswordResetCodeUseCase {
  constructor(
    private readonly userService: UserService,
    private readonly passwordResetCodeService: PasswordResetCodeService,
    private readonly authService: AuthService,
  ) {}

  async execute(
    dto: VerifyResetCodeDto,
  ): Promise<BaseResponse<{ resetToken: string }>> {
    const user = await this.userService.findOneByEmail(dto.email.toLowerCase());
    if (!user) {
      throw new BadRequestException(
        'Código de verificación inválido o expirado',
      );
    }

    await this.passwordResetCodeService.verifyAndConsume(user.id, dto.code);

    return {
      success: true,
      message: 'Código verificado correctamente',
      data: { resetToken: this.authService.signPasswordResetToken(user.id) },
    };
  }
}
