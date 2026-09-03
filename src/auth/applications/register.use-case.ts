import { Injectable, Logger } from '@nestjs/common';

import { OrganizationInvitationService } from 'src/account/organization-invitation.service';
import { PasswordService } from 'src/shared/password/password.service';
import { TurnstileService } from 'src/shared/turnstile/turnstile.service';
import { UserService } from 'src/user/user.service';

import { RegisterDto } from '../dto/register.dto';

/**
 * Da de alta una cuenta pública (`POST /auth/register`) y la deja en pre-registro
 * (`isEmailVerified=false`); quien la activa es `VerifyRegistrationOtpUseCase` con el código que
 * sale por correo desde acá.
 *
 * Cuando el registro viene de `/signup?...&token=...`, `dto.invitationToken` llega presente y el
 * usuario se une automáticamente a esa organización: sin ese paso tendría cuenta pero nunca la
 * membresía.
 */
@Injectable()
export class RegisterUseCase {
  private readonly logger = new Logger(RegisterUseCase.name);

  constructor(
    private readonly userService: UserService,
    private readonly organizationInvitationService: OrganizationInvitationService,
    private readonly passwordService: PasswordService,
    private readonly turnstileService: TurnstileService,
  ) {}

  async execute(dto: RegisterDto) {
    /**
     * Primera línea del método y no un guard ni un paso posterior: el CAPTCHA existe para que
     * un bot no llegue siquiera a crear el pre-registro (ni a disparar el correo del OTP), así
     * que esta verificación tiene que ocurrir antes de cualquier escritura o envío.
     * `verifyToken` lanza si el token falta, es inválido, expiró o ya fue canjeado — no
     * devuelve un booleano que alguien pueda ignorar por descuido.
     */
    await this.turnstileService.verifyToken(dto.turnstileToken);

    const hashedPassword = await this.passwordService.hash(dto.password);
    const result = await this.userService.createFromSignup(dto, hashedPassword);

    if (dto.invitationToken) {
      await this.joinInvitedOrganization(
        dto.invitationToken,
        result.data.userId,
      );
    }

    return result;
  }

  /**
   * Best-effort a propósito, igual que el refresco del catálogo de Redis en
   * `UserService.createFromSignup`: un fallo acá (token ya usado, expirado o inválido) no debe
   * tumbar un registro que por lo demás fue exitoso — el usuario simplemente no queda unido a
   * la organización y puede reintentar el enlace de `/join` manualmente.
   */
  private async joinInvitedOrganization(
    invitationToken: string,
    userId: string,
  ): Promise<void> {
    try {
      await this.organizationInvitationService.acceptForUser(
        invitationToken,
        userId,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo unir al usuario recién registrado ${userId} a la organización de la invitación: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
