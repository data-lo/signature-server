import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SharedModule } from 'src/shared/shared.module';
import { IdentityVerificationEntity } from './entities/identity-verification.entity';
import { DiditApiService } from './didit/didit-api.service';
import { StartDiditVerificationUseCase } from './applications/start-didit-verification.use-case';
import { GetCurrentIdentityVerificationUseCase } from './applications/get-current-identity-verification.use-case';
import { ProcessDiditVerificationResultUseCase } from './applications/process-didit-verification-result.use-case';
import { AssertIdentityApprovedUseCase } from './applications/assert-identity-approved.use-case';
import { RefreshSigningCredentialStatusUseCase } from './applications/refresh-signing-credential-status.use-case';
import { IdentityVerificationsController } from './identity-verifications.controller';

/**
 * Dominio de verificación de identidad: iniciar intentos, consultarlos y aplicar resultados.
 *
 * Sin servicio de orquestación: cada operación es un caso de uso en `applications/`, y la única
 * pieza que no lo es (`DiditApiService`) es un adaptador HTTP, no lógica de dominio.
 *
 * **Este módulo no importa `UserModule` ni `SignatureModule` a propósito.** `UserModule` importa
 * `SignatureModule`, y `SignatureModule` importa este módulo para bloquear el alta de firma sin
 * identidad aprobada: importar de vuelta cerraría el ciclo. Por eso el acceso a `users` es por
 * repositorio (`TypeOrmModule.forFeature`) y el cache de perfil se invalida vía `RedisService`
 * en lugar de llamar a `UserService`.
 *
 * `ProcessDiditVerificationResultUseCase` se exporta para que el módulo de webhooks —que recibe
 * el POST de Didit y valida su firma HMAC— lo invoque con el payload ya autenticado. La
 * dependencia irá en un solo sentido: `webhooks` importará este módulo, nunca al revés. Aquí no
 * hay controller de webhooks ni validación de firma, por diseño.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([IdentityVerificationEntity, UserEntity]),
    SharedModule,
  ],
  controllers: [IdentityVerificationsController],
  providers: [
    DiditApiService,
    StartDiditVerificationUseCase,
    GetCurrentIdentityVerificationUseCase,
    ProcessDiditVerificationResultUseCase,
    AssertIdentityApprovedUseCase,
    RefreshSigningCredentialStatusUseCase,
  ],
  exports: [
    AssertIdentityApprovedUseCase,
    RefreshSigningCredentialStatusUseCase,
    ProcessDiditVerificationResultUseCase,
  ],
})
export class IdentityVerificationModule {}
