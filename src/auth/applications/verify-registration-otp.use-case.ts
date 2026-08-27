import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { UserEntity } from 'src/user/entities/user.entity';
import { EmailVerificationCodeService } from 'src/user/email-verification-code.service';
import { UserService } from 'src/user/user.service';

import { AuthService } from '../auth.service';
import { VerifyOtpDto } from '../dto/verify-otp.dto';

/**
 * `POST /auth/verify-otp`: canjea el código que se envió al registrarse y activa la cuenta.
 *
 * Tras validar el OTP el usuario queda autenticado de inmediato, con el mismo JWT que emitiría
 * un login: acaba de completar todo el formulario de registro y demostrar que controla el
 * correo, así que pedirle que además inicie sesión a mano sería un paso sin ningún valor.
 */
@Injectable()
export class VerifyRegistrationOtpUseCase {
  constructor(
    private readonly userService: UserService,
    private readonly emailVerificationCodeService: EmailVerificationCodeService,
    private readonly authService: AuthService,
  ) {}

  async execute(
    dto: VerifyOtpDto,
  ): Promise<BaseResponse<{ user: UserEntity; token: string }>> {
    const user = await this.userService.findOneByEmail(dto.email.toLowerCase());
    if (!user) {
      throw new NotFoundException(
        'No hay una solicitud de registro pendiente para este correo',
      );
    }
    if (user.isEmailVerified) {
      throw new ConflictException(
        'Este correo ya fue verificado. Inicia sesión.',
      );
    }

    // Lanza si el código no coincide o venció, y lo consume para que no sirva dos veces.
    await this.emailVerificationCodeService.verifyAndConsume(user.id, dto.code);

    const verifiedUser = await this.userService.markEmailVerified(user.id);

    return {
      success: true,
      message: 'Correo verificado correctamente',
      data: {
        user: this.userService.sanitize(verifiedUser),
        token: this.authService.signJwtForUser(verifiedUser),
      },
    };
  }
}
