import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { AccountService } from 'src/account/account.service';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { PasswordService } from 'src/common/password/password.service';
import { UserEntity } from 'src/user/entities/user.entity';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';
import { UserService } from 'src/user/user.service';

import { AuthService } from '../auth.service';
import { LoginDto } from '../dto/login.dto';

/**
 * `POST /auth/login`: inicio de sesión con correo y contraseña.
 *
 * La credencial se resuelve contra `Account.email`/`Account.password` (plan de migración ER-V2,
 * Fase 5) y no contra `User.email`/`.password`. Son una copia sincronizada de la credencial
 * única de la persona (decisión D6): un usuario con varias cuentas —personal más
 * organizaciones— tiene el mismo correo y contraseña en cada fila, así que cualquiera de ellas
 * resuelve el mismo `userId`.
 *
 * Todos los motivos de rechazo por credenciales dan el mismo 401 con el mismo texto: separar
 * "ese correo no existe" de "esa contraseña no es" convertiría el endpoint en un oráculo de qué
 * correos están registrados.
 *
 * Un usuario `PROVISIONED` —creado por la API de integración al recibir un documento a su nombre—
 * no inicia sesión con contraseña. Normalmente su cuenta no tiene contraseña y cae en el mismo 401
 * de siempre; si consiguió una (por ejemplo, con el restablecimiento de contraseña), responde 403
 * porque ya demostró conocerla y lo que le falta es completar su registro.
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
    // Sin contraseña (usuario aprovisionado) no hay nada contra qué comparar: mismo 401.
    if (!account?.password) {
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
    if (user.lifecycleStatus === USER_LIFECYCLE_STATUS_ENUM.PROVISIONED) {
      throw new ForbiddenException(
        'Tu cuenta se creó desde una integración y todavía no está activada. Completa tu registro para iniciar sesión.',
      );
    }

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
