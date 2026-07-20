import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './guards/api-key.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
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
