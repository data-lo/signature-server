import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './guards/api-key.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RegisterUseCase } from './applications/register.use-case';
import { LoginUseCase } from './applications/login.use-case';
import { VerifyRegistrationOtpUseCase } from './applications/verify-registration-otp.use-case';
import { UpdatePreRegistrationUseCase } from './applications/update-pre-registration.use-case';
import { ResendRegistrationOtpUseCase } from './applications/resend-registration-otp.use-case';
import { RequestPasswordResetUseCase } from './applications/request-password-reset.use-case';
import { VerifyPasswordResetCodeUseCase } from './applications/verify-password-reset-code.use-case';
import { ResetPasswordUseCase } from './applications/reset-password.use-case';
import { LogoutUseCase } from './applications/logout.use-case';
import { GetAuthenticatedUserUseCase } from './applications/get-authenticated-user.use-case';
import { PasswordResetCodeService } from './password-reset-code.service';
import { PasswordResetCodeEntity } from './entities/password-reset-code.entity';
import { UserModule } from '../user/user.module';
import { AccountModule } from '../account/account.module';
import { SharedModule } from '../shared/shared.module';

/**
 * Módulo de autenticación.
 * Registra ApiKeyGuard y JwtAuthGuard como guards globales (se combinan con AND):
 * las rutas @Public() exigen x-api-key, las demás exigen un JWT válido y no
 * invalidado, salvo las marcadas con @SkipJwtAuth() (registro/login).
 */
@Module({
  imports: [
    UserModule,
    AccountModule,
    SharedModule,
    TypeOrmModule.forFeature([PasswordResetCodeEntity]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: config.get('JWT_EXPIRES_IN') ?? '1h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordResetCodeService,
    RegisterUseCase,
    LoginUseCase,
    VerifyRegistrationOtpUseCase,
    UpdatePreRegistrationUseCase,
    ResendRegistrationOtpUseCase,
    RequestPasswordResetUseCase,
    VerifyPasswordResetCodeUseCase,
    ResetPasswordUseCase,
    LogoutUseCase,
    GetAuthenticatedUserUseCase,
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AuthModule {}
