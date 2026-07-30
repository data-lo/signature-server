import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { UserService } from '../user/user.service';
import { AccountService } from '../account/account.service';
import { OrganizationInvitationService } from '../account/organization-invitation.service';
import { EmailVerificationCodeService } from '../user/email-verification-code.service';
import { EmailService } from '../shared/email/email.service';
import { PasswordService } from '../shared/password/password.service';
import { RedisService } from '../shared/redis/redis.service';
import { maskEmail } from '../shared/utils/mask-email.util';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
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
    private readonly emailVerificationCodeService: EmailVerificationCodeService,
    private readonly emailService: EmailService,
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
  async register(dto: RegisterDto) {
    const hashedPassword = await this.passwordService.hash(dto.password);
    const result = await this.userService.createFromSignup(dto, hashedPassword);

    if (dto.invitationToken) {
      try {
        await this.organizationInvitationService.acceptForUser(
          dto.invitationToken,
          result.data.userId,
        );
      } catch (error) {
        this.logger.warn(
          `No se pudo unir al usuario recién registrado ${result.data.userId} a la organización de la invitación: ${
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

    // Una pre-cuenta (isEmailVerified=false) tiene contraseña real desde que se registró, pero
    // no debe poder iniciar sesión saltándose la verificación de correo (ver historia "Auth:
    // Flujo de Pre-registro, Verificación OTP y Control por CURP") — 403 en vez de 401 para que
    // el frontend pueda distinguir "credenciales inválidas" de "falta verificar tu correo" y
    // mandar al usuario a la pantalla de OTP en vez de un error genérico.
    if (!user.isEmailVerified) {
      throw new ForbiddenException(
        'Debes verificar tu correo antes de iniciar sesión',
      );
    }

    const token = this.signJwtForUser(user);

    return {
      success: true,
      message: 'Inicio de sesión exitoso',
      data: { user: this.userService.sanitize(user), token },
    };
  }

  private signJwtForUser(user: UserEntity): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      nationalId: user.nationalId,
      jti: randomUUID(),
    };
    return this.jwtService.sign(payload);
  }

  /**
   * Valida el OTP de verificación de correo (ver EmailVerificationCodeService) y, si es
   * correcto, activa la cuenta (isEmailVerified=true) y autentica al usuario de inmediato —
   * ya completó todo el formulario de registro, no tiene sentido pedirle que inicie sesión
   * de nuevo manualmente.
   */
  async verifyOtp(
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

    await this.emailVerificationCodeService.verifyAndConsume(user.id, dto.code);

    const verifiedUser = await this.userService.markEmailVerified(user.id);
    const token = this.signJwtForUser(verifiedUser);

    return {
      success: true,
      message: 'Correo verificado correctamente',
      data: { user: this.userService.sanitize(verifiedUser), token },
    };
  }

  /** Reenvía un OTP nuevo para un pre-registro pendiente (ver botón "Reenviar código" en /signup/verify). */
  async resendOtp(
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
      // Best-effort, igual que en UserService.createFromSignup: un fallo de SendGrid no debe
      // tumbar el endpoint — el código ya quedó persistido y el usuario puede reintentar el
      // reenvío si de verdad nunca le llegó.
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
