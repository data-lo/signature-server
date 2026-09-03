import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { AccountService } from 'src/account/account.service';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { PasswordService } from 'src/shared/password/password.service';
import { UserEntity } from 'src/user/entities/user.entity';
import { UserService } from 'src/user/user.service';

import { AuthService } from '../auth.service';
import { LoginDto } from '../dto/login.dto';

/**
 * Inicia sesión con correo y contraseña (`POST /auth/login`).
 *
 * Resuelve la credencial contra `Account.email`/`.password` y no contra `User`: son una copia
 * sincronizada de la credencial única de la persona (decisión D6), así que un usuario con varias
 * cuentas tiene el mismo correo y contraseña en cada fila y cualquiera resuelve el mismo `userId`.
 *
 * Todos los motivos de rechazo dan el mismo 401 con el mismo texto: separar "ese correo no existe"
 * de "esa contraseña no es" convertiría el endpoint en un oráculo de qué correos están registrados.
 */
@Injectable()
export class LoginUseCase {
  constructor(
    private readonly accountService: AccountService,
    private readonly userService: UserService,
    private readonly passwordService: PasswordService,
    private readonly authService: AuthService,
  ) {}

  async execute(
    dto: LoginDto,
  ): Promise<BaseResponse<{ user: UserEntity; token: string }>> {
    const account = await this.accountService.findActiveAccountByEmail(
      dto.email.toLowerCase(),
    );
    if (!account) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const matches = await this.passwordService.compare(
      dto.password,
      account.password,
    );
    if (!matches) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const user = await this.userService
      .findOne(account.userId)
      .catch(() => null);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    /**
     * Una pre-cuenta (`isEmailVerified=false`) tiene contraseña real desde que se registró,
     * pero no debe poder iniciar sesión saltándose la verificación de correo (ver historia
     * "Auth: Flujo de Pre-registro, Verificación OTP y Control por CURP"). 403 en vez de 401
     * para que el frontend pueda distinguir "credenciales inválidas" de "falta verificar tu
     * correo" y mandar al usuario a la pantalla de OTP en vez de a un error genérico.
     */
    if (!user.isEmailVerified) {
      throw new ForbiddenException(
        'Debes verificar tu correo antes de iniciar sesión',
      );
    }

    return {
      success: true,
      message: 'Inicio de sesión exitoso',
      data: {
        user: this.userService.sanitize(user),
        token: this.authService.signJwtForUser(user),
      },
    };
  }
}
