import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from 'src/audit/audit.module';
import { SharedModule } from 'src/common/shared.module';

import { SigningInvitationEntity } from './entities/signing-invitation.entity';
import { SigningInvitationDeliveryService } from './signing-invitation-delivery.service';
import { SigningInvitationService } from './signing-invitation.service';
import { SigningLinkService } from './signing-link.service';
import { SigningRateLimitService } from './signing-rate-limit.service';

/**
 * Invitaciones individuales de firma (`/sign/:token`): emitirlas, encontrarlas por token, decidir
 * qué enlace lleva el correo de cada firmante, reenviarlas con sus límites y limitar la frecuencia
 * de lo que se hace con ellas.
 *
 * Sólo depende de su tabla, de `SharedModule` (Redis, correo) y de `AuditModule`, a propósito: lo
 * importan `DocumentModule`, `KafkaModule` y `PublicSigningModule`, y depender de cualquiera de
 * ellos haría un ciclo.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SigningInvitationEntity]),
    SharedModule,
    AuditModule,
  ],
  providers: [
    SigningInvitationService,
    SigningLinkService,
    SigningRateLimitService,
    SigningInvitationDeliveryService,
  ],
  exports: [
    SigningInvitationService,
    SigningLinkService,
    SigningRateLimitService,
    SigningInvitationDeliveryService,
  ],
})
export class SigningInvitationModule {}
