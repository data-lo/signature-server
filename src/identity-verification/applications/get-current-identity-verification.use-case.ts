import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { CurrentIdentityVerification } from '../interfaces/current-verification.interface';

/** Estados en los que la URL hospedada todavía sirve para continuar el flujo. */
const RESUMABLE_STATUSES = [
  IDENTITY_VERIFICATION_STATUS_ENUM.PENDING,
  IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
];

/**
 * Devuelve el último intento de verificación del usuario junto con el estado de su credencial
 * de firma: es lo que alimenta la pantalla "Identidad y firma" de una sola llamada.
 *
 * Se devuelve el intento más reciente y no "el aprobado si existe": el usuario tiene que ver en
 * qué va *ahora*, incluido un reintento en curso después de un rechazo.
 */
@Injectable()
export class GetCurrentIdentityVerificationUseCase {
  constructor(
    @InjectRepository(IdentityVerificationEntity)
    private readonly identityVerificationRepository: Repository<IdentityVerificationEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  async execute(userId: string): Promise<CurrentIdentityVerification> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    const latest = await this.identityVerificationRepository.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    return {
      verification: latest
        ? {
            id: latest.id,
            provider: latest.provider,
            status: latest.status,
            url: this.resumableUrl(latest),
            failureReason: latest.failureReason,
            startedAt: latest.startedAt,
            completedAt: latest.completedAt,
            expiresAt: latest.expiresAt,
            createdAt: latest.createdAt,
          }
        : null,
      signingCredentialStatus: user.signingCredentialStatus,
      /**
       * Bandera derivada, no una segunda fuente de verdad: el frontend la usa para el caso
       * binario "¿ya puede firmar?" sin tener que comparar contra el enum, pero cualquier
       * decisión más fina se toma con `signingCredentialStatus`.
       */
      signingCredentialConfigured:
        user.signingCredentialStatus ===
        SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
      identityVerifiedAt: user.identityVerifiedAt,
      signatureRegistered: user.signatureId !== null,
    };
  }

  /**
   * La URL sólo se expone mientras el intento siga abierto y vigente. Devolverla en un intento
   * ya rechazado o expirado invitaría al frontend a reabrir una sesión muerta de Didit en vez
   * de arrancar una nueva.
   */
  private resumableUrl(attempt: IdentityVerificationEntity): string | null {
    if (!RESUMABLE_STATUSES.includes(attempt.status)) {
      return null;
    }

    if (attempt.expiresAt && attempt.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    const hostedUrl = attempt.providerMetadata?.hostedUrl;
    return typeof hostedUrl === 'string' && hostedUrl ? hostedUrl : null;
  }
}
