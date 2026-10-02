import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SharedModule } from 'src/common/shared.module';
import { DocumentModule } from 'src/document/document.module';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { IdentityVerificationModule } from 'src/identity-verification/identity-verification.module';
import { IdentityVerificationEntity } from 'src/identity-verification/entities/identity-verification.entity';

import { BiometricSignatureAttemptEntity } from './entities/biometric-signature-attempt.entity';
import { BiometricSignatureDiditService } from './didit/biometric-signature-didit.service';
import { GuestAccessTokenService } from './guest/guest-access-token.service';
import { GuestAccessGuard } from './guest/guest-access.guard';
import { BiometricSignatureAttemptService } from './services/biometric-signature-attempt.service';
import { BiometricSignerService } from './services/biometric-signer.service';
import { BiometricSessionLauncherService } from './services/biometric-session-launcher.service';
import { StartAccountBiometricSignatureUseCase } from './applications/start-account-biometric-signature.use-case';
import { StartGuestBiometricSignatureUseCase } from './applications/start-guest-biometric-signature.use-case';
import { GetBiometricSignatureStatusUseCase } from './applications/get-biometric-signature-status.use-case';
import { GuestBiometricAccessUseCases } from './applications/guest-access.use-cases';
import { ProcessBiometricSignatureResultUseCase } from './applications/process-biometric-signature-result.use-case';
import { BiometricSignatureController } from './biometric-signature.controller';
import { PublicBiometricSignatureController } from './public-biometric-signature.controller';

/**
 * Firma biométrica con Didit, para firmantes con cuenta (Biometric Authentication contra su
 * identidad aprobada) e invitados sin cuenta (KYC, tras validar un código en su correo).
 *
 * Dependencias, todas en un solo sentido:
 * - `DocumentModule`: quién firma y cómo se registra la firma (`SignDocumentUseCase`, la misma
 *   política y los mismos códigos de verificación que la firma normal).
 * - `IdentityVerificationModule`: el adaptador HTTP de Didit y el descargador de su media. Nada de
 *   la identidad del onboarding cambia por una firma.
 *
 * `WebhooksModule` importa éste: recibe y autentica la entrega de Didit y, por el `session_id`, le
 * entrega a `ProcessBiometricSignatureResultUseCase` las que son de una firma.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      BiometricSignatureAttemptEntity,
      CollaboratorEntity,
      IdentityVerificationEntity,
    ]),
    SharedModule,
    DocumentModule,
    IdentityVerificationModule,
  ],
  controllers: [
    BiometricSignatureController,
    PublicBiometricSignatureController,
  ],
  providers: [
    BiometricSignatureDiditService,
    GuestAccessTokenService,
    GuestAccessGuard,
    BiometricSignatureAttemptService,
    BiometricSignerService,
    BiometricSessionLauncherService,
    StartAccountBiometricSignatureUseCase,
    StartGuestBiometricSignatureUseCase,
    GetBiometricSignatureStatusUseCase,
    GuestBiometricAccessUseCases,
    ProcessBiometricSignatureResultUseCase,
  ],
  exports: [
    BiometricSignatureAttemptService,
    ProcessBiometricSignatureResultUseCase,
  ],
})
export class BiometricSignatureModule {}
