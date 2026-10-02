import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BiometricSignatureAttemptEntity } from '../entities/biometric-signature-attempt.entity';
import {
  ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES,
  BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM,
} from '../enums/biometric-signature-attempt-status.enum';
import { BiometricSignatureSession } from '../interfaces/biometric-signature-session.interface';

/**
 * Lecturas y reglas de `biometric_signature_attempts` que comparten iniciar, consultar y el
 * webhook: cuál es el intento abierto de un colaborador, si su URL todavía sirve y cómo se presenta
 * al frontend. No escribe estados ni habla con Didit.
 */
@Injectable()
export class BiometricSignatureAttemptService {
  constructor(
    @InjectRepository(BiometricSignatureAttemptEntity)
    private readonly attemptRepository: Repository<BiometricSignatureAttemptEntity>,
  ) {}

  /**
   * Busca el intento abierto (PENDING o IN_PROGRESS) de un colaborador, sobre cualquier versión del
   * PDF. Con el índice único parcial hay a lo sumo uno por hash; se toma el más reciente.
   *
   * @param collaboratorId - Colaborador firmante.
   * @returns El intento abierto más reciente, o `null`.
   *
   * @example
   * ```ts
   * const active = await attempts.findActive('c-1');
   * ```
   */
  findActive(
    collaboratorId: string,
  ): Promise<BiometricSignatureAttemptEntity | null> {
    return this.attemptRepository.findOne({
      where: {
        collaboratorId,
        status: In([...ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES]),
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Busca el intento más reciente de un colaborador, esté abierto o no.
   *
   * @param collaboratorId - Colaborador firmante.
   * @returns El último intento, o `null` si nunca inició uno.
   *
   * @example
   * ```ts
   * const latest = await attempts.findLatest('c-1');
   * ```
   */
  findLatest(
    collaboratorId: string,
  ): Promise<BiometricSignatureAttemptEntity | null> {
    return this.attemptRepository.findOne({
      where: { collaboratorId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Busca el intento de una sesión de Didit. Es lo que usa el dispatcher del webhook para decidir
   * si la entrega es de una firma biométrica o de una verificación de identidad.
   *
   * @param providerSessionId - `session_id` del webhook.
   * @returns El intento de esa sesión, o `null` si no es de una firma biométrica.
   *
   * @example
   * ```ts
   * const attempt = await attempts.findBySession('didit-session-1');
   * ```
   */
  findBySession(
    providerSessionId: string,
  ): Promise<BiometricSignatureAttemptEntity | null> {
    return this.attemptRepository.findOne({ where: { providerSessionId } });
  }

  /**
   * Indica si un intento no ha vencido según el `expires_at` de Didit. Sin vencimiento informado
   * se considera vigente: Didit cierra la sesión por webhook cuando la da por vencida.
   *
   * @param attempt - Intento a evaluar.
   * @param now - Instante de referencia; por defecto, el actual.
   * @returns `true` si no tiene vencimiento o todavía no llega.
   *
   * @example
   * ```ts
   * attempts.isUnexpired(attempt); // true
   * ```
   */
  isUnexpired(
    attempt: BiometricSignatureAttemptEntity,
    now: Date = new Date(),
  ): boolean {
    return !attempt.expiresAt || attempt.expiresAt.getTime() > now.getTime();
  }

  /**
   * Indica si la sesión de un intento abierto se le puede devolver al firmante para continuar:
   * mismo PDF, vigente y con URL hospedada.
   *
   * @param attempt - Intento abierto del colaborador.
   * @param currentDocumentHash - `original_hash` vigente del documento.
   * @returns `true` si la URL sigue sirviendo para esta firma.
   *
   * @example
   * ```ts
   * attempts.isResumable(active, document.originalHash);
   * ```
   */
  isResumable(
    attempt: BiometricSignatureAttemptEntity,
    currentDocumentHash: string,
  ): boolean {
    return (
      ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES.includes(attempt.status) &&
      attempt.documentHash === currentDocumentHash &&
      this.isUnexpired(attempt) &&
      this.hostedUrl(attempt) !== null
    );
  }

  /**
   * Arma la respuesta para el frontend. La URL sólo se entrega mientras el intento está abierto y
   * vigente; el veredicto nunca.
   *
   * @param attempt - Intento a presentar.
   * @param options.reused - Si se devolvió una sesión existente en vez de crear otra.
   * @param options.signatureCompleted - Si el colaborador ya quedó firmado.
   * @param options.documentCompleted - Si el documento quedó firmado por todos; por defecto `false`.
   * @returns La sesión lista para serializar.
   *
   * @example
   * ```ts
   * attempts.toSession(attempt, { reused: false, signatureCompleted: false });
   * ```
   */
  toSession(
    attempt: BiometricSignatureAttemptEntity,
    options: {
      reused: boolean;
      signatureCompleted: boolean;
      documentCompleted?: boolean;
    },
  ): BiometricSignatureSession {
    const canOpen =
      ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES.includes(attempt.status) &&
      this.isUnexpired(attempt);

    return {
      attemptId: attempt.id,
      status: attempt.status,
      url: canOpen ? this.hostedUrl(attempt) : null,
      expiresAt: attempt.expiresAt,
      reused: options.reused,
      signatureCompleted: options.signatureCompleted,
      documentCompleted: options.documentCompleted ?? false,
    };
  }

  /**
   * Indica si un estado es terminal: el intento ya no cambia por sí solo.
   *
   * @param status - Estado del intento.
   * @returns `true` para APPROVED, DECLINED, EXPIRED y FAILED.
   *
   * @example
   * ```ts
   * attempts.isTerminal(BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.DECLINED); // true
   * ```
   */
  isTerminal(status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM): boolean {
    return !ACTIVE_BIOMETRIC_SIGNATURE_ATTEMPT_STATUSES.includes(status);
  }

  /**
   * URL hospedada de Didit guardada en el intento.
   *
   * @param attempt - Intento.
   * @returns La URL, o `null` si no hay.
   *
   * @example
   * ```ts
   * this.hostedUrl(attempt); // 'https://verify.didit.me/…'
   * ```
   */
  private hostedUrl(attempt: BiometricSignatureAttemptEntity): string | null {
    const url = attempt.providerMetadata?.hostedUrl;
    return typeof url === 'string' && url.length > 0 ? url : null;
  }
}
