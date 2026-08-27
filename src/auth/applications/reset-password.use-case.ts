import { Injectable, UnauthorizedException } from '@nestjs/common';

import { AccountService } from 'src/account/account.service';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { PasswordService } from 'src/shared/password/password.service';
import { UserService } from 'src/user/user.service';

import { AuthService } from '../auth.service';
import { ResetPasswordDto } from '../dto/reset-password.dto';

/**
 * `POST /auth/reset-password`: fija la contraseña nueva con el `resetToken` que devolvió el
 * canje del OTP.
 *
 * El token se verifica acá y no en `JwtAuthGuard` porque el endpoint es `@SkipJwtAuth`: quien
 * cambia su contraseña justamente no tiene sesión. Se prefiere el token a volver a pedir correo
 * más código porque el OTP ya se consumió en el paso anterior.
 *
 * La invalidación de sesiones del final hace, de paso, que el propio `resetToken` sea de un solo
 * uso: tras un reset exitoso la marca queda en "ahora", así que reintentar con el mismo token
 * —cuyo `iat` es anterior— queda rechazado igual que cualquier sesión previa. Es lo que se
 * quiere si alguien llegó a interceptarlo: cambiar la contraseña expulsa a todo el mundo,
 * incluido quien acaba de hacerlo.
 */
@Injectable()
export class ResetPasswordUseCase {
  constructor(
    private readonly userService: UserService,
    private readonly accountService: AccountService,
    private readonly passwordService: PasswordService,
    private readonly authService: AuthService,
  ) {}

  async execute(dto: ResetPasswordDto): Promise<BaseResponse<null>> {
    const payload = await this.authService.verifyPasswordResetToken(
      dto.resetToken,
    );

    const validAfter = await this.authService.getSessionsValidAfter(
      payload.sub,
    );
    if (validAfter && payload.iat && payload.iat < validAfter) {
      throw new UnauthorizedException('Este enlace ya fue utilizado');
    }

    const hashedPassword = await this.passwordService.hash(dto.newPassword);

    /**
     * Las dos escrituras hacen falta: `User.password` es la credencial de la persona y
     * `Account.password` su copia sincronizada (decisión D6), que es contra la que resuelve el
     * login. Actualizar sólo una dejaría al usuario sin poder entrar con ninguna de las dos
     * contraseñas.
     */
    await this.userService.updatePassword(payload.sub, hashedPassword);
    await this.accountService.updatePasswordForUser(
      payload.sub,
      hashedPassword,
    );

    await this.authService.invalidateSessionsFor(payload.sub);

    return {
      success: true,
      message: 'Contraseña actualizada correctamente',
      data: null,
    };
  }
}
