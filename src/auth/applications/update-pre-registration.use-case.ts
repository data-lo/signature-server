import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { PasswordService } from 'src/shared/password/password.service';
import { SignupPendingVerificationData } from 'src/user/interfaces/response/signup-pending-verification-response';
import { UserService } from 'src/user/user.service';

import { UpdatePreRegistrationDto } from '../dto/update-pre-registration.dto';

/**
 * `PATCH /auth/pre-registration`: corrige los datos de un registro que todavía no verifica su
 * correo (ver historia "Permitir corregir datos antes de verificar el correo").
 *
 * Lo que autoriza el cambio es la contraseña del propio pre-registro, no el OTP: cuando el error
 * está justamente en el correo, el código nunca llega y no habría forma de demostrar nada.
 *
 * Se responde con los mismos mensajes que el login ante credenciales incorrectas, para no
 * convertir este endpoint en un oráculo que confirme qué correos tienen un registro pendiente.
 */
@Injectable()
export class UpdatePreRegistrationUseCase {
  constructor(
    private readonly userService: UserService,
    private readonly passwordService: PasswordService,
  ) {}

  async execute(
    dto: UpdatePreRegistrationDto,
  ): Promise<BaseResponse<SignupPendingVerificationData>> {
    const user = await this.userService.findOneByEmail(
      dto.currentEmail.toLowerCase(),
    );
    if (!user) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const matches = await this.passwordService.compare(
      dto.password,
      user.password,
    );
    if (!matches) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Una cuenta ya verificada se corrige desde la sesión iniciada, no por esta vía pública.
    if (user.isEmailVerified) {
      throw new ConflictException(
        'Este correo ya fue verificado. Inicia sesión para editar tus datos.',
      );
    }

    return this.userService.updatePreRegistration(user, {
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      nationalId: dto.nationalId,
      rfc: dto.rfc,
    });
  }
}
