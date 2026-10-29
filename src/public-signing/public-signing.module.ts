import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from 'src/audit/audit.module';
import { BiometricSignatureModule } from 'src/biometric-signature/biometric-signature.module';
import { SharedModule } from 'src/common/shared.module';
import { DocumentModule } from 'src/document/document.module';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { IdentityVerificationEntity } from 'src/identity-verification/entities/identity-verification.entity';
import { IdentityVerificationModule } from 'src/identity-verification/identity-verification.module';
import { SignatureModule } from 'src/signature/signature.module';
import { SigningInvitationModule } from 'src/signing-invitation/signing-invitation.module';
import { UserEntity } from 'src/user/entities/user.entity';

import { GetSigningInvitationUseCase } from './applications/get-signing-invitation.use-case';
import { PublicSigningSessionUseCases } from './applications/public-signing-session.use-cases';
import { SigningInvitationAccessUseCases } from './applications/signing-invitation-access.use-cases';
import { PublicSigningSessionGuard } from './guards/public-signing-session.guard';
import { SigningInvitationAccessGuard } from './guards/signing-invitation-access.guard';
import { PublicSigningInvitationsController } from './public-signing-invitations.controller';
import { PublicSigningLaunchesController } from './public-signing-launches.controller';
import { PublicSigningSessionsController } from './public-signing-sessions.controller';
import { PublicSignerIdentityService } from './services/public-signer-identity.service';
import { PublicSigningInvitationResolver } from './services/public-signing-invitation-resolver.service';
import { PublicSigningSessionTokenService } from './services/public-signing-session-token.service';
import { SigningIdempotencyService } from './services/signing-idempotency.service';
import { SigningInvitationAccessTokenService } from './services/signing-invitation-access-token.service';
import { SigningPolicyResolver } from './services/signing-policy.resolver';

/**
 * Firma pública por invitación individual (`/sign/:token`): la audiencia del colaborador
 * invitado, sin JWT ni API key.
 *
 * - `PublicSigningInvitationsController`: el token de la invitación del correo (consultar, canjear,
 *   renovar) y, con la cookie de acceso que deja cualquier canje, el código del correo.
 * - `PublicSigningLaunchesController`: el canje del acceso temporal del portal del tercero.
 * - `PublicSigningSessionsController`: la sesión abierta con el código, en cookie `HttpOnly`
 *   (`PublicSigningSessionGuard`).
 *
 * No firma por su cuenta: arma el actor `PUBLIC_INVITATION` y delega en lo que ya existe
 * (`SignDocumentUseCase`, la verificación de Didit, la rúbrica, la biometría de invitado, los
 * códigos, los accesos, el correo y la auditoría).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CollaboratorEntity,
      IdentityVerificationEntity,
      UserEntity,
    ]),
    SharedModule,
    AuditModule,
    DocumentModule,
    SigningInvitationModule,
    SignatureModule,
    IdentityVerificationModule,
    BiometricSignatureModule,
  ],
  controllers: [
    PublicSigningInvitationsController,
    PublicSigningLaunchesController,
    PublicSigningSessionsController,
  ],
  providers: [
    PublicSigningInvitationResolver,
    PublicSigningSessionTokenService,
    PublicSigningSessionGuard,
    SigningInvitationAccessTokenService,
    SigningInvitationAccessGuard,
    SigningIdempotencyService,
    GetSigningInvitationUseCase,
    SigningInvitationAccessUseCases,
    PublicSigningSessionUseCases,
    SigningPolicyResolver,
    PublicSignerIdentityService,
  ],
})
export class PublicSigningModule {}
