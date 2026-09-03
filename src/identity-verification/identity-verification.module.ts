import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SharedModule } from 'src/shared/shared.module';
import { IdentityVerificationEntity } from './entities/identity-verification.entity';
import { DiditApiService } from './didit/didit-api.service';
import { StartDiditVerificationUseCase } from './applications/start-didit-verification.use-case';
import { GetCurrentIdentityVerificationUseCase } from './applications/get-current-identity-verification.use-case';
import { ProcessDiditVerificationResultUseCase } from './applications/process-didit-verification-result.use-case';
import { UpdateSigningCredentialStatusUseCase } from './applications/update-signing-credential-status.use-case';
import { ValidateVerificationAttemptsUseCase } from './applications/validate-verification-attempts.use-case';
import { IdentityVerificationsController } from './identity-verifications.controller';

/**
 * Dominio de verificación de identidad: iniciar intentos, consultarlos y aplicar resultados.
 *
 * Sin servicio de orquestación: cada operación es un caso de uso en `applications/`, y la única pieza
 * que no lo es (`DiditApiService`) es un adaptador HTTP.
 *
 * **No importa `UserModule` ni `SignatureModule` a propósito**: `UserModule` importa
 * `SignatureModule`, y éste importa el presente módulo para bloquear el alta de firma sin identidad
 * aprobada, así que importar de vuelta cerraría el ciclo. Por eso el acceso a `users` es por
 * repositorio y el cache de perfil se invalida vía `RedisService` en lugar de llamar a
 * `UserService`.
 *
 * Exporta `ProcessDiditVerificationResultUseCase` para que el módulo de webhooks —que recibe el POST
 * de Didit, valida su firma HMAC y comprueba el payload— lo invoque con el cuerpo ya autenticado. La
 * dependencia va en un solo sentido: `webhooks` importa a éste, nunca al revés, y acá no hay
 * controller de webhooks ni validación de firma por diseño.
 *
 * Exporta también `UpdateSigningCredentialStatusUseCase`: es el único escritor de
 * `users.signing_credential_status`, y `SignatureModule` lo necesita para mover al usuario a
 * CONFIGURED o de vuelta a SIGNATURE_PENDING al dar de alta o eliminar su firma PNG.
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
    UpdateSigningCredentialStatusUseCase,
    ValidateVerificationAttemptsUseCase,
  ],
  exports: [
    ProcessDiditVerificationResultUseCase,
    UpdateSigningCredentialStatusUseCase,
  ],
})
export class IdentityVerificationModule {}
