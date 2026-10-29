import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SharedModule } from 'src/common/shared.module';
import { DocumentModule } from 'src/document/document.module';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';

import { GuestSigningTokenService } from './guest/guest-signing-token.service';
import { GuestSigningAccessGuard } from './guest/guest-signing-access.guard';
import { GuestAdvancedSignerService } from './services/guest-advanced-signer.service';
import { GuestAdvancedSignatureAccessUseCases } from './applications/guest-advanced-signature-access.use-cases';
import { PublicGuestAdvancedSignatureController } from './public-guest-advanced-signature.controller';

/**
 * Firma Electrónica Avanzada (FIEL) del invitado sin cuenta: acreditar el correo con un código
 * `GUEST_ADVANCED_SIGNATURE_ACCESS`, canjearlo por un acceso temporal y firmar con él.
 *
 * Depende sólo de `DocumentModule`, en un sentido: de ahí salen el registro de la firma
 * (`SignDocumentUseCase.executeGuestAdvanced`, el mismo final que la firma privada), los códigos
 * de verificación y `GuestSigningAccessService`, que vive allá porque los flujos de documentos son
 * los que revocan los accesos.
 *
 * No crea `User` ni `Account`: la identidad del firmante es el `Collaborator`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CollaboratorEntity]),
    SharedModule,
    DocumentModule,
  ],
  controllers: [PublicGuestAdvancedSignatureController],
  providers: [
    GuestSigningTokenService,
    GuestSigningAccessGuard,
    GuestAdvancedSignerService,
    GuestAdvancedSignatureAccessUseCases,
  ],
})
export class GuestAdvancedSignatureModule {}
