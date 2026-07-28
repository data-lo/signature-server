import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { UserService } from '../user/user.service';
import { AccountService } from '../account/account.service';
import { OrganizationInvitationService } from '../account/organization-invitation.service';
import { PasswordService } from '../shared/password/password.service';
import { RedisService } from '../shared/redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { BaseResponse } from '../interfaces/api-response.dto';
import { UserEntity } from '../user/entities/user.entity';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userService: UserService,
    private readonly accountService: AccountService,
    private readonly organizationInvitationService: OrganizationInvitationService,
    private readonly jwtService: JwtService,
    private readonly passwordService: PasswordService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Camino B de la historia [STORY] Eventos Kafka, Email (SendGrid) y Miembros (/join): cuando
   * el registro viene de /signup?...&token=... (RFC nuevo en /join), `dto.invitationToken`
   * viene presente y el usuario recién creado se une automáticamente a esa organización — sin
   * esto, "completar el registro y unirse a la organización" (Escenario 4 de la historia)
   * quedaría a medias: el usuario tendría cuenta, pero nunca la membresía.
   *
   * Best-effort a propósito, igual que el refresco del catálogo de Redis en
   * UserService.createFromSignup: un fallo aquí (token ya usado, expirado, o inválido) no debe
   * tumbar un registro que por lo demás fue exitoso — el usuario simplemente no queda unido a
   * la organización y puede reintentar el enlace de /join manualmente.
   */
  async register(dto: RegisterDto): Promise<BaseResponse<UserEntity>> {
    const hashedPassword = await this.passwordService.hash(dto.password);
    const result = await this.userService.createFromSignup(dto, hashedPassword);

    if (dto.invitationToken) {
      try {
        await this.organizationInvitationService.acceptForUser(
          dto.invitationToken,
          result.data.id,
        );
      } catch (error) {
        this.logger.warn(
          `No se pudo unir al usuario recién registrado ${result.data.id} a la organización de la invitación: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return result;
  }

  /**
   * Resuelve la credencial contra `Account.email`/`Account.password` (ver plan de migración
   * ER-V2, Fase 5) en vez de `User.email`/`.password` directamente. `Account.email`/`.password`
   * son una copia sincronizada de la credencial única del usuario (decisión D6) — un usuario
   * con varias cuentas (personal + organizaciones) tiene el mismo email/password en cada fila,
   * así que cualquiera de ellas resuelve el mismo `userId`. `sub`/`roles`/`nationalId` del JWT
   * siguen viniendo de `UserEntity`, que sigue siendo la identidad de la persona.
   */
  async login(
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

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      nationalId: user.nationalId,
      jti: randomUUID(),
    };
    const token = this.jwtService.sign(payload);

    return {
      success: true,
      message: 'Inicio de sesión exitoso',
      data: { user: this.userService.sanitize(user), token },
    };
  }

  async logout(payload: JwtPayload): Promise<BaseResponse<null>> {
    const ttl = payload.exp ? payload.exp - Math.floor(Date.now() / 1000) : 0;
    if (ttl > 0) {
      await this.redisService.set(`blacklist:${payload.jti}`, '1', ttl);
    }
    return {
      success: true,
      message: 'Sesión cerrada correctamente',
      data: null,
    };
  }

  async me(payload: JwtPayload) {
    return this.userService.findOneActiveUser(payload.sub, true);
  }
}
