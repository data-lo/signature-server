import { Injectable, Logger } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { EmailService } from 'src/shared/email/email.service';
import { UserService } from 'src/user/user.service';

import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { PasswordResetCodeService } from '../password-reset-code.service';

const PASSWORD_RESET_GENERIC_MESSAGE =
  'Si el correo está registrado, recibirás un código de verificación';

/**
 * `POST /auth/forgot-password`: arranca la recuperación de contraseña mandando un OTP al correo.
 *
 * "Verificado" se traduce como `isActive: true` (el único flag de legitimidad que existe hoy en
 * `UserEntity`) — ver historia "Recuperación de Contraseña mediante Código de Verificación OTP".
 *
 * La respuesta es siempre la misma, exista el correo o no, esté activo o no y se haya podido
 * mandar el mensaje o no: cualquier diferencia permitiría enumerar qué correos tienen cuenta.
 * Lo que sí cambia según el caso es el log del servidor, y eso es deliberado: antes "el usuario
 * no existe", "está inactivo" y "falló el envío" eran indistinguibles —los dos primeros ni
 * siquiera dejaban rastro—, y por eso este flujo pudo estar caído en producción sin que nadie
 * lo notara.
 */
@Injectable()
export class RequestPasswordResetUseCase {
  private readonly logger = new Logger(RequestPasswordResetUseCase.name);

  constructor(
    private readonly userService: UserService,
    private readonly passwordResetCodeService: PasswordResetCodeService,
    private readonly emailService: EmailService,
  ) {}

  async execute(dto: ForgotPasswordDto): Promise<BaseResponse<null>> {
    const email = dto.email.toLowerCase();
    const user = await this.userService.findOneByEmail(email);

    if (!user) {
      this.logger.warn(
        `Recuperación de contraseña solicitada para un correo sin usuario registrado (${email}). No se envía correo.`,
      );
      return this.genericResponse();
    }

    if (!user.isActive) {
      this.logger.warn(
        `Recuperación de contraseña solicitada para el usuario inactivo ${user.id}. No se envía correo.`,
      );
      return this.genericResponse();
    }

    /**
     * La emisión del código (base de datos) se separa del envío (SendGrid): antes ambos
     * compartían el mismo catch y un fallo al escribir en `password_reset_codes` se reportaba
     * como "no se pudo enviar el correo", apuntando al proveedor equivocado.
     */
    let resetCode: { code: string };
    try {
      resetCode = await this.passwordResetCodeService.issue(user.id);
    } catch (error) {
      this.logger.error(
        `No se pudo EMITIR el código de recuperación para el usuario ${user.id} (fallo al escribir en base de datos, no del proveedor de correo): ${
          error instanceof Error ? error.stack : String(error)
        }`,
      );
      return this.genericResponse();
    }

    try {
      await this.emailService.sendPasswordResetOtpNotification(
        user.email,
        resetCode.code,
      );
    } catch (error) {
      /**
       * Best-effort, igual que el resto del código (ver `UserService.createFromSignup`): un
       * fallo de SendGrid no debe delatar nada distinto al mensaje genérico ni tumbar la
       * respuesta — el usuario puede volver a pedir el código.
       */
      this.logger.error(
        `No se pudo ENVIAR el correo de recuperación de contraseña a ${user.email} (el código sí quedó emitido): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return this.genericResponse();
  }

  /** Respuesta única del flujo: idéntica en todos los casos (anti-enumeración). */
  private genericResponse(): BaseResponse<null> {
    return {
      success: true,
      message: PASSWORD_RESET_GENERIC_MESSAGE,
      data: null,
    };
  }
}
