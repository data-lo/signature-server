import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { RefreshSigningCredentialStatusUseCase } from './refresh-signing-credential-status.use-case';

/**
 * Traducción del vocabulario de Didit al del dominio.
 *
 * Las claves están normalizadas (minúsculas, sin espacios ni guiones) porque Didit escribe
 * `In Review` en unos lugares e `in_review` en otros según el endpoint. Un estado que no esté
 * en esta tabla cae en FAILED a propósito: un estado desconocido no puede tratarse como
 * aprobación.
 */
const DIDIT_STATUS_MAP: Record<string, IDENTITY_VERIFICATION_STATUS_ENUM> = {
  notstarted: IDENTITY_VERIFICATION_STATUS_ENUM.PENDING,
  inprogress: IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
  inreview: IDENTITY_VERIFICATION_STATUS_ENUM.IN_REVIEW,
  approved: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
  declined: IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED,
  abandoned: IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED,
  expired: IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED,
  kycexpired: IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED,
};

/** Estados terminales: llegado uno de estos, el intento no cambia más por sí solo. */
const TERMINAL_STATUSES = [
  IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
  IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED,
  IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED,
  IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED,
  IDENTITY_VERIFICATION_STATUS_ENUM.FAILED,
];

/**
 * Aplica al intento local el resultado que Didit reportó por webhook.
 *
 * Punto de entrada del módulo `webhooks`, que es donde viven la recepción HTTP y la validación
 * de la firma HMAC. Acá está exclusivamente qué significa el resultado para la identidad del
 * usuario.
 *
 * **Contrato explícito: este caso de uso asume que la autenticidad del payload YA fue
 * verificada.** No valida firmas ni conoce cabeceras HTTP; quien lo invoque es responsable de
 * no entregarle nunca un cuerpo no confiable. Se expone con una firma deliberadamente genérica
 * (`Record<string, unknown>`) para que el módulo de webhooks pueda llamarlo sin que este módulo
 * dependa de él.
 */
@Injectable()
export class ProcessDiditVerificationResultUseCase {
  private readonly logger = new Logger(
    ProcessDiditVerificationResultUseCase.name,
  );

  constructor(
    @InjectRepository(IdentityVerificationEntity)
    private readonly identityVerificationRepository: Repository<IdentityVerificationEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly refreshSigningCredentialStatus: RefreshSigningCredentialStatusUseCase,
  ) {}

  async execute(payload: Record<string, unknown>): Promise<void> {
    const sessionId = this.asString(payload.session_id);

    if (!sessionId) {
      this.logger.warn(
        'Webhook de Didit sin session_id: no hay forma de saber a qué intento aplica.',
      );
      return;
    }

    const attempt = await this.findAttempt(sessionId, payload);

    if (!attempt) {
      // No es un error nuestro: puede ser una sesión creada desde el panel de Didit, o de otro
      // entorno apuntando al mismo webhook. Se registra y se ignora, sin romper la entrega.
      this.logger.warn(
        `Webhook de Didit para la sesión ${sessionId}, que no corresponde a ningún intento local.`,
      );
      return;
    }

    const status = this.mapStatus(payload.status);

    /**
     * Didit no garantiza el orden de entrega: un `In Progress` retrasado puede llegar después
     * del `Approved`. Sin esta guarda, ese reordenamiento degradaría una identidad ya aprobada
     * y le quitaría al usuario la posibilidad de firmar.
     */
    if (
      TERMINAL_STATUSES.includes(attempt.status) &&
      attempt.status !== status
    ) {
      this.logger.warn(
        `Se ignora el estado ${status} para la sesión ${sessionId}: el intento ya está en ${attempt.status}.`,
      );
      return;
    }

    const isTerminal = TERMINAL_STATUSES.includes(status);

    await this.identityVerificationRepository.update(attempt.id, {
      status,
      decision: this.asObject(payload.decision) ?? attempt.decision,
      failureReason: this.resolveFailureReason(status, payload),
      completedAt: isTerminal ? new Date() : attempt.completedAt,
    });

    if (status === IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED) {
      await this.userRepository.update(attempt.userId, {
        identityVerifiedAt: new Date(),
      });
    }

    /**
     * Se recalcula siempre, no sólo al aprobar: si un intento aprobado termina en EXPIRED, la
     * credencial de firma tiene que dejar de estar configurada por la misma vía por la que se
     * configuró.
     */
    await this.refreshSigningCredentialStatus.execute(attempt.userId);

    this.logger.log(
      `Verificación ${attempt.id} (sesión ${sessionId}) actualizada a ${status}.`,
    );
  }

  /**
   * Búsqueda por `session_id` y, si falla, por `vendor_data`.
   *
   * `vendor_data` es el `userId` que mandamos al crear la sesión. El respaldo cubre un caso
   * real: si la respuesta del alta se pierde (timeout de red después de que Didit ya creó la
   * sesión), el intento local quedó sin `provider_session_id`, pero el webhook sí trae de
   * vuelta nuestro identificador y permite reconciliarlo.
   */
  private async findAttempt(
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<IdentityVerificationEntity | null> {
    const bySession = await this.identityVerificationRepository.findOne({
      where: {
        provider: IDENTITY_VERIFICATION_PROVIDER_ENUM.DIDIT,
        providerSessionId: sessionId,
      },
    });

    if (bySession) {
      return bySession;
    }

    const userId = this.asString(payload.vendor_data);
    if (!userId) {
      return null;
    }

    const orphan = await this.identityVerificationRepository.findOne({
      where: {
        provider: IDENTITY_VERIFICATION_PROVIDER_ENUM.DIDIT,
        userId,
        providerSessionId: IsNull(),
      },
      order: { createdAt: 'DESC' },
    });

    if (orphan) {
      // Se ata la sesión al intento huérfano para que las entregas siguientes lo encuentren
      // por la vía normal.
      await this.identityVerificationRepository.update(orphan.id, {
        providerSessionId: sessionId,
      });
      orphan.providerSessionId = sessionId;
    }

    return orphan;
  }

  private mapStatus(value: unknown): IDENTITY_VERIFICATION_STATUS_ENUM {
    const normalized = this.asString(value)
      ?.toLowerCase()
      .replace(/[\s_-]/g, '');

    if (!normalized) {
      return IDENTITY_VERIFICATION_STATUS_ENUM.FAILED;
    }

    const mapped = DIDIT_STATUS_MAP[normalized];

    if (!mapped) {
      this.logger.warn(
        `Estado de Didit desconocido: "${String(value)}". Se registra como FAILED.`,
      );
      return IDENTITY_VERIFICATION_STATUS_ENUM.FAILED;
    }

    return mapped;
  }

  /**
   * Sólo se guarda motivo en los estados que lo tienen. Dejar un `failure_reason` colgado de un
   * intento que después se aprobó haría que la pantalla mostrara un rechazo inexistente.
   */
  private resolveFailureReason(
    status: IDENTITY_VERIFICATION_STATUS_ENUM,
    payload: Record<string, unknown>,
  ): string | null {
    if (
      status !== IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED &&
      status !== IDENTITY_VERIFICATION_STATUS_ENUM.FAILED
    ) {
      return null;
    }

    const decision = this.asObject(payload.decision);

    return (
      this.asString(payload.reason) ??
      this.asString(decision?.reason) ??
      this.asString(decision?.warning) ??
      'El proveedor no pudo validar la identidad.'
    );
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
