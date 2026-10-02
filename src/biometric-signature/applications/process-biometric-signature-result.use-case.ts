import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';

import { SignDocumentUseCase } from 'src/document/applications/sign-document.use-case';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';

import { BiometricSignatureAttemptEntity } from '../entities/biometric-signature-attempt.entity';
import {
  ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES,
  BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM,
} from '../enums/biometric-signature-attempt-status.enum';
import {
  findMissingApproval,
  toBiometricDecisionEvidence,
} from '../didit/biometric-decision-evidence.mapper';
import { toBiometricVendorData } from '../didit/biometric-signature-didit.service';

/**
 * Vocabulario de Didit → estado del intento. Claves normalizadas (minúsculas, sin espacios ni
 * guiones). `In Review` sigue "en proceso" para el firmante; `Abandoned` se resuelve igual que una
 * expiración. Un estado desconocido cae en FAILED: nunca puede leerse como aprobación.
 */
const DIDIT_STATUS_MAP: Record<
  string,
  BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM
> = {
  notstarted: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
  inprogress: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
  inreview: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS,
  approved: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED,
  declined: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED,
  abandoned: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED,
  expired: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED,
  kycexpired: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED,
};

/** Motivo que queda en `failure_reason` para cada desenlace negativo de Didit. */
const FAILURE_REASONS: Partial<
  Record<BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM, string>
> = {
  [BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED]:
    'Didit rechazó la verificación biométrica',
  [BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED]:
    'La sesión de Didit venció o se abandonó antes de completarse',
  [BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED]:
    'Didit reportó un estado no reconocido',
};

/**
 * Aplica a un intento de firma biométrica el resultado que Didit reportó por webhook y, si es una
 * aprobación, registra la firma del colaborador.
 *
 * **Asume que el módulo `webhooks` ya autenticó la entrega (HMAC), validó su forma, la registró de
 * forma idempotente y resolvió el intento por `providerSessionId`.** Aquí sólo se decide qué
 * significa el resultado.
 *
 * El webhook es la única fuente de verdad: ni el regreso del navegador desde Didit ni ninguna
 * llamada del frontend aprueban un intento. El veredicto se guarda reducido (ver
 * `toBiometricDecisionEvidence`) y nunca se registra en logs.
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
    private readonly signDocument: SignDocumentUseCase,
  ) {}

  /**
   * Procesa la entrega de Didit sobre un intento ya resuelto.
   *
   * - **Aprobado**: sólo un intento activo puede aprobarse (`UPDATE` condicionado: dos entregas
   *   simultáneas no aprueban dos veces). Se exige que el veredicto traiga aprobadas las pruebas
   *   del tipo de firmante y se registra la firma vía `SignDocumentUseCase.executeBiometric`, que
   *   revalida hash, estado y turno antes del claim atómico `PENDING → SIGNED`.
   * - **Rechazado, vencido o fallido**: sólo se mueve el intento; el colaborador sigue en
   *   `PENDING` y puede reintentar con otra sesión.
   * - Un estado viejo nunca pisa uno terminal, y una reentrega de una firma ya registrada no hace
   *   nada.
   *
   * @param attempt - Intento de la sesión del webhook.
   * @param payload - Cuerpo del webhook de Didit, ya autenticado y validado.
   * @returns Nada.
   *
   * @throws {Error} Errores inesperados al firmar (base de datos, MinIO, sellado): se propagan
   *   para que la entrega quede en FAILED y Didit la reintente. Los rechazos de negocio (4xx de la
   *   firma) NO se propagan: cierran el intento en FAILED.
   *
   * @example
   * ```ts
   * await processBiometricSignatureResult.execute(attempt, payload);
   * ```
   */
  async execute(
    attempt: BiometricSignatureAttemptEntity,
    payload: Record<string, unknown>,
  ): Promise<void> {
    /**
     * `vendor_data` tiene que ser el de ESTE intento. Si no, alguien aplica una sesión ajena: se
     * ignora sin tocar nada (y sin pasarla a la verificación de identidad).
     */
    if (payload.vendor_data !== toBiometricVendorData(attempt.id)) {
      this.logger.warn(
        `Webhook de Didit para el intento ${attempt.id} con un vendor_data que no le corresponde: se ignora.`,
      );
      return;
    }

    const sessionStatus =
      typeof payload.status === 'string' ? payload.status : null;
    const status = this.mapStatus(sessionStatus);
    const evidence = toBiometricDecisionEvidence(
      sessionStatus,
      this.asObject(payload.decision),
    );

    if (status === BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED) {
      await this.applyApproval(attempt, evidence);
      return;
    }

    await this.applyNonApproval(attempt, status, evidence);
  }

  /**
   * Aprueba un intento activo y registra la firma; o retoma la firma de uno ya aprobado cuyo
   * colaborador quedó pendiente por un fallo transitorio.
   *
   * @param attempt - Intento de la sesión.
   * @param evidence - Veredicto ya reducido.
   * @returns Nada.
   *
   * @throws {Error} Errores inesperados al firmar (ver `execute`).
   *
   * @example
   * ```ts
   * await this.applyApproval(attempt, evidence);
   * ```
   */
  private async applyApproval(
    attempt: BiometricSignatureAttemptEntity,
    evidence: ReturnType<typeof toBiometricDecisionEvidence>,
  ): Promise<void> {
    if (attempt.status === BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED) {
      // Reentrega tras un fallo transitorio (la entrega anterior quedó en FAILED): se retoma.
      await this.signApprovedAttempt(attempt);
      return;
    }

    if (!ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES.includes(attempt.status)) {
      this.logger.warn(
        `Aprobación para el intento ${attempt.id}, que ya no está activo (${attempt.status}): se ignora.`,
      );
      return;
    }

    const missing = findMissingApproval(evidence, attempt.userId === null);
    if (missing) {
      await this.close(
        attempt,
        BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        {
          decision: evidence,
          failureReason: `Didit aprobó la sesión, pero el veredicto no trae ${missing} aprobada`,
        },
      );
      return;
    }

    const approval = await this.attemptRepository.update(
      {
        id: attempt.id,
        status: In([...ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES]),
      },
      {
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED,
        decision: evidence,
        failureReason: null,
        completedAt: new Date(),
      },
    );
    if (approval.affected !== 1) {
      this.logger.warn(
        `Otra entrega ya cerró el intento ${attempt.id}: esta aprobación no vuelve a firmar.`,
      );
      return;
    }
    attempt.status = BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.APPROVED;

    await this.signApprovedAttempt(attempt);
  }

  /**
   * Registra la firma respaldada por un intento aprobado, una sola vez. Si el colaborador ya está
   * firmado (reentrega), no hace nada; si la firma es rechazada por una regla de negocio, cierra el
   * intento en FAILED.
   *
   * @param attempt - Intento ya en APPROVED.
   * @returns Nada.
   *
   * @throws {Error} Errores inesperados al firmar, para que Didit reintente.
   *
   * @example
   * ```ts
   * await this.signApprovedAttempt(attempt);
   * ```
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
      await this.signDocument.executeBiometric(attempt.id);
    } catch (error) {
      if (!this.isBusinessRejection(error)) {
        throw error;
      }

      /**
       * Dos entregas de aprobación casi simultáneas: la otra ganó el claim y esta recibió "ya
       * respondiste". La firma SÍ quedó registrada; marcar el intento como fallido sería falso.
       */
      const current = await this.collaboratorRepository.findOne({
        where: { id: attempt.collaboratorId },
      });
      if (current?.status === COLLABORATOR_STATUS_ENUM.SIGNED) {
        return;
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
   * Aplica un resultado que no es aprobación. El colaborador sigue en PENDING: sólo se mueve el
   * intento, condicionado al estado leído para no pisar una aprobación que llegó en paralelo.
   *
   * @param attempt - Intento de la sesión.
   * @param status - Estado traducido de Didit.
   * @param evidence - Veredicto ya reducido.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si falla la escritura.
   *
   * @example
   * ```ts
   * await this.applyNonApproval(attempt, BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED, evidence);
   * ```
   */
  private async applyNonApproval(
    attempt: BiometricSignatureAttemptEntity,
    status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM,
    evidence: ReturnType<typeof toBiometricDecisionEvidence>,
  ): Promise<void> {
    if (!ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES.includes(attempt.status)) {
      this.logger.warn(
        `Se ignora el estado ${status} para el intento ${attempt.id}: ya está en ${attempt.status}.`,
      );
      return;
    }

    if (ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES.includes(status)) {
      await this.attemptRepository.update(
        { id: attempt.id, status: attempt.status },
        { status },
      );
      return;
    }

    await this.close(attempt, status, {
      decision: evidence,
      failureReason: FAILURE_REASONS[status] ?? null,
    });
  }

  /**
   * Cierra un intento activo en un estado terminal, condicionado al estado leído.
   *
   * @param attempt - Intento a cerrar.
   * @param status - Estado terminal.
   * @param fields - Veredicto reducido y motivo.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si falla la escritura.
   *
   * @example
   * ```ts
   * await this.close(attempt, BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED, { decision, failureReason });
   * ```
   */
  private async close(
    attempt: BiometricSignatureAttemptEntity,
    status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM,
    fields: {
      decision: ReturnType<typeof toBiometricDecisionEvidence>;
      failureReason: string | null;
    },
  ): Promise<void> {
    await this.attemptRepository.update(
      { id: attempt.id, status: attempt.status },
      {
        status,
        decision: fields.decision,
        failureReason: fields.failureReason,
        completedAt: new Date(),
      },
    );
  }

  /**
   * Un rechazo de negocio de la firma es un 4xx de `SignDocumentUseCase`: el PDF cambió, ya no es
   * su turno, el documento ya no está pendiente… Reintentar la entrega no lo arreglaría.
   *
   * @param error - Lo que lanzó la firma.
   * @returns `true` si es una `HttpException` 4xx.
   *
   * @example
   * ```ts
   * this.isBusinessRejection(new BadRequestException('x')); // true
   * ```
   */
  private isBusinessRejection(error: unknown): error is HttpException {
    return error instanceof HttpException && error.getStatus() < 500;
  }

  /**
   * Traduce el estado de Didit al del intento; uno desconocido cae en FAILED.
   *
   * @param value - `status` de la entrega.
   * @returns El estado del intento.
   *
   * @example
   * ```ts
   * this.mapStatus('In Review'); // IN_PROGRESS
   * ```
   */
  private mapStatus(
    value: string | null,
  ): BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM {
    const normalized = (value ?? '').toLowerCase().replace(/[\s_-]/g, '');
    return (
      DIDIT_STATUS_MAP[normalized] ??
      BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED
    );
  }

  /**
   * Devuelve el valor si es un objeto plano (no arreglo ni `null`).
   *
   * @param value - Valor del payload.
   * @returns El objeto, o `null`.
   *
   * @example
   * ```ts
   * this.asObject({ a: 1 }); // { a: 1 }
   * ```
   */
  private asObject(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
