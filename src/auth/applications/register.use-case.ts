import { Injectable } from '@nestjs/common';

import { PasswordService } from 'src/common/password/password.service';
import { TurnstileService } from 'src/common/turnstile/turnstile.service';
import { UserService } from 'src/user/user.service';

import { RegisterDto } from '../dto/register.dto';

/**
 * `POST /auth/register`: alta pública de una cuenta.
 *
 * El registro deja al usuario en pre-registro (`isEmailVerified=false`); quien lo activa es
 * `VerifyRegistrationOtpUseCase` con el código que sale por correo desde acá.
 *
 * **No acepta invitaciones.** Hasta la historia "Unificar invitaciones de miembros y vincular
 * cuentas nuevas por token", un `invitationToken` en el cuerpo unía aquí mismo al usuario recién
 * creado a la organización. Ahora el registro sólo crea la cuenta, y es el frontend quien, en
 * cuanto este endpoint responde bien, llama a
 * `POST /organizations/invitations/:token/accept` con el RFC recién registrado. Separarlos hace
 * que la invitación no pueda romper un registro, y deja un solo camino de aceptación —el mismo
 * que usa quien ya tenía cuenta—.
 */
@Injectable()
export class RegisterUseCase {
  constructor(
    private readonly userService: UserService,
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

    return result;
  }
}
