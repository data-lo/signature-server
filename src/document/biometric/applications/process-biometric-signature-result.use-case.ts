import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import { SignDocumentUseCase } from '../../applications/sign-document.use-case';
import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { BiometricSignatureAttemptEntity } from '../entities/biometric-signature-attempt.entity';
import {
  ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES,
  BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM,
} from '../enums/biometric-signature-attempt-status.enum';
import { BiometricSignatureAttemptService } from '../services/biometric-signature-attempt.service';

/**
 * Vocabulario de Didit → estado del intento. Claves normalizadas (minúsculas, sin espacios ni
 * guiones), igual que en la verificación de identidad. Un estado desconocido cae en FAILED: nunca
 * puede leerse como aprobación.
 */
const DIDIT_STATUS_MAP: Record<
  string,
  BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM
> = {
  notstarted: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
  inprogress: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
  inreview: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_REVIEW,
  approved: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED,
  declined: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED,
  abandoned: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.ABANDONED,
  expired: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED,
  kycexpired: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED,
};

/** Motivo que queda en `failure_reason` para cada desenlace negativo de Didit. */
const FAILURE_REASONS: Partial<
  Record<BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM, string>
> = {
  [BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED]:
    'Didit rechazó la verificación biométrica',
  [BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.ABANDONED]:
    'El firmante abandonó la verificación biométrica',
  [BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED]:
    'La sesión de Didit venció antes de completarse',
  [BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED]:
    'Didit reportó un estado no reconocido',
};

/**
 * Aplica a un intento de firma biométrica el resultado que Didit reportó por webhook y, si es una
 * aprobación, registra la firma.
 *
 * **Asume que la autenticidad del payload YA se verificó** (firma HMAC y forma, en el módulo
 * `webhooks`) y que la entrega ya se registró de forma idempotente en `webhook_events`.
 *
 * El webhook es la única fuente de verdad: ni el retorno del navegador desde Didit ni ninguna
 * llamada del frontend pueden aprobar un intento.
 */
@Injectable()
export class ProcessBiometricSignatureResultUseCase {
  private readonly logger = new Logger(
    ProcessBiometricSignatureResultUseCase.name,
  );

  constructor(
    @InjectRepository(BiometricSignatureAttemptEntity)
    private readonly attemptRepository: Repository<BiometricSignatureAttemptEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly attemptService: BiometricSignatureAttemptService,
    private readonly signDocument: SignDocumentUseCase,
  ) {}

  /**
   * Procesa el webhook si su sesión pertenece a una firma biométrica.
   *
   * Devuelve `false` cuando la sesión no es de ningún intento biométrico, para que quien llama la
   * entregue a la verificación de identidad: las dos usan el mismo endpoint de Didit y sólo el
   * `session_id` dice de cuál es.
   *
   * Reglas de orden e idempotencia (Didit reentrega y no garantiza el orden):
   * - Una aprobación gana sobre un estado terminal que no lo sea (expiró o se abandonó y la
   *   aprobación llegó después), salvo que ya se hubiera aprobado antes.
   * - Cualquier otro estado no pisa un estado terminal.
   * - Si la aprobación ya firmó (colaborador en SIGNED), una reentrega no vuelve a firmar.
   *
   * @param payload - Cuerpo del webhook de Didit, ya autenticado y validado.
   * @returns `true` si la sesión era de una firma biométrica (procesada o ignorada a propósito);
   *   `false` si no lo era.
   *
   * @throws {Error} Errores inesperados al firmar (base de datos, MinIO, sellado): se propagan para
   *   que la entrega quede en FAILED y Didit la reintente. Los rechazos de negocio de la firma (el
   *   documento cambió de estado, ya no es su turno) NO se propagan: cierran el intento en FAILED.
   *
   * @example
   * ```ts
   * const handled = await processBiometricSignatureResult.execute(payload);
   * if (!handled) await processDiditVerificationResult.execute(payload);
   * ```
   */
  async execute(payload: Record<string, unknown>): Promise<boolean> {
    const sessionId = this.asString(payload.session_id);
    if (!sessionId) {
      return false;
    }

    const attempt = await this.attemptService.findBySession(sessionId);
    if (!attempt) {
      return false;
    }

    /**
     * `vendor_data` es el usuario que inició la sesión. Si no coincide, alguien está aplicando una
     * sesión ajena a este intento: se ignora sin tocar nada, y tampoco se le pasa a la verificación
     * de identidad.
     */
    if (this.asString(payload.vendor_data) !== attempt.userId) {
      this.logger.warn(
        `Webhook de Didit para la sesión biométrica ${sessionId} con un vendor_data que no corresponde al intento ${attempt.id}: se ignora.`,
      );
      return true;
    }

    const status = this.mapStatus(payload.status);
    const decision = this.asObject(payload.decision);

    if (status === BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED) {
      await this.applyApproval(attempt, decision);
      return true;
    }

    await this.applyNonApproval(attempt, status, decision);
    return true;
  }

  /**
   * Marca el intento como aprobado y registra la firma del colaborador.
   *
   * Si el intento ya se había aprobado y la firma no pudo aplicarse (quedó en FAILED con
   * `approved_at`), no se reintenta: el motivo ya quedó registrado y el firmante tiene que iniciar
   * otra sesión.
   */
  private async applyApproval(
    attempt: BiometricSignatureAttemptEntity,
    decision: Record<string, unknown> | null,
  ): Promise<void> {
    if (attempt.status !== BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED) {
      if (attempt.approvedAt) {
        this.logger.warn(
          `Aprobación repetida para el intento ${attempt.id}, que ya se aprobó y quedó en ${attempt.status}: se ignora.`,
        );
        return;
      }

      const now = new Date();
      await this.attemptRepository.update(attempt.id, {
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED,
        decision: decision ?? attempt.decision,
        failureReason: null,
        approvedAt: now,
        completedAt: now,
      });
      attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;
      attempt.approvedAt = now;
    }

    await this.signApprovedAttempt(attempt);
  }

  /**
   * Registra la firma respaldada por un intento aprobado, una sola vez.
   *
   * Pasa por `SignDocumentUseCase` —con el mismo claim atómico, las mismas validaciones de estado,
   * turno y código, y la misma finalización— para que la firma biométrica no tenga un camino
   * paralelo que pueda divergir de las otras.
   */
  private async signApprovedAttempt(
    attempt: BiometricSignatureAttemptEntity,
  ): Promise<void> {
    const collaborator = await this.collaboratorRepository.findOne({
      where: { id: attempt.collaboratorId },
    });

    if (collaborator?.status === COLLABORATOR_STATUS_ENUM.SIGNED) {
      this.logger.log(
        `El colaborador ${attempt.collaboratorId} ya está firmado: la aprobación ${attempt.id} no vuelve a firmar.`,
      );
      return;
    }

    try {
      await this.signDocument.execute(
        attempt.documentId,
        attempt.userId,
        undefined,
        attempt.geolocation,
        undefined,
        attempt.id,
      );
    } catch (error) {
      if (!this.isBusinessRejection(error)) {
        throw error;
      }

      const reason = `La biometría se aprobó, pero no se pudo registrar la firma: ${error.message}`;
      this.logger.warn(`Intento ${attempt.id}: ${reason}`);
      await this.attemptRepository.update(attempt.id, {
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason: reason,
        completedAt: new Date(),
      });
      return;
    }

    // Cualquier otra sesión que el firmante hubiera dejado abierta ya no tiene nada que firmar.
    await this.attemptRepository.update(
      {
        collaboratorId: attempt.collaboratorId,
        id: Not(attempt.id),
        status: In([...ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES]),
      },
      {
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason: 'La firma ya se registró con otra sesión biométrica',
        completedAt: new Date(),
      },
    );
  }

  /**
   * Aplica un resultado que no es aprobación. El colaborador sigue en PENDING y puede volver a
   * intentarlo: sólo se mueve el intento.
   *
   * El `UPDATE` va condicionado al estado leído, para no pisar una aprobación que haya llegado en
   * paralelo.
   */
  private async applyNonApproval(
    attempt: BiometricSignatureAttemptEntity,
    status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM,
    decision: Record<string, unknown> | null,
  ): Promise<void> {
    const isOpen = ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES.includes(
      attempt.status,
    );

    if (!isOpen && attempt.status !== status) {
      this.logger.warn(
        `Se ignora el estado ${status} para la sesión ${attempt.providerSessionId}: el intento ya está en ${attempt.status}.`,
      );
      return;
    }

    const isTerminal =
      !ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES.includes(status);

    await this.attemptRepository.update(
      { id: attempt.id, status: attempt.status },
      {
        status,
        decision: decision ?? attempt.decision,
        failureReason: FAILURE_REASONS[status] ?? null,
        completedAt: isTerminal ? new Date() : attempt.completedAt,
      },
    );
  }

  /**
   * Un rechazo de negocio de la firma es una respuesta HTTP 4xx de `SignDocumentUseCase`: el
   * documento ya no está pendiente, ya no es su turno, el PDF cambió… Reintentar la entrega no lo
   * arreglaría, así que no debe propagarse a Didit.
   */
  private isBusinessRejection(error: unknown): error is HttpException {
    return error instanceof HttpException && error.getStatus() < 500;
  }

  private mapStatus(value: unknown): BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM {
    const normalized = this.asString(value)
      ?.toLowerCase()
      .replace(/[\s_-]/g, '');
    return (
      DIDIT_STATUS_MAP[normalized ?? ''] ??
      BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED
    );
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
