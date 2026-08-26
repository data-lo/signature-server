import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { EmailService } from 'src/shared/email/email.service';
import { maskEmail } from 'src/shared/utils/mask-email.util';
import { EmailVerificationCodeService } from 'src/user/email-verification-code.service';
import { UserService } from 'src/user/user.service';

import { ResendOtpDto } from '../dto/resend-otp.dto';

/**
 * `POST /auth/resend-otp`: emite y manda un código nuevo para un pre-registro pendiente (botón
 * "Reenviar código" de `/signup/verify`).
 */
@Injectable()
export class ResendRegistrationOtpUseCase {
  private readonly logger = new Logger(ResendRegistrationOtpUseCase.name);

  constructor(
    private readonly userService: UserService,
    private readonly emailVerificationCodeService: EmailVerificationCodeService,
    private readonly emailService: EmailService,
  ) {}

  async execute(
    dto: ResendOtpDto,
  ): Promise<BaseResponse<{ email: string; maskedEmail: string }>> {
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

    const verificationCode = await this.emailVerificationCodeService.issue(
      user.id,
    );

    try {
      await this.emailService.sendRegistrationOtpNotification(
        user.email,
        verificationCode.code,
      );
    } catch (error) {
      /**
       * Best-effort, igual que en `UserService.createFromSignup`: un fallo de SendGrid no debe
       * tumbar el endpoint — el código ya quedó persistido y el usuario puede reintentar el
       * reenvío si de verdad nunca le llegó.
       */
      this.logger.warn(
        `No se pudo enviar el correo de reenvío de verificación a ${user.email}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      success: true,
      message: 'Reenviamos un nuevo código de verificación a tu correo',
      data: { email: user.email, maskedEmail: maskEmail(user.email) },
    };
  }
}
