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
 * Lecturas y reglas de `biometric_signature_attempts` que comparten iniciar y consultar una firma
 * biométrica: cuál es el intento abierto de un colaborador, si su URL todavía sirve y cómo se
 * presenta al frontend.
 *
 * No escribe estados ni habla con Didit: eso lo hacen los casos de uso.
 */
@Injectable()
export class BiometricSignatureAttemptService {
  constructor(
    @InjectRepository(BiometricSignatureAttemptEntity)
    private readonly attemptRepository: Repository<BiometricSignatureAttemptEntity>,
  ) {}

  /**
   * Busca el intento abierto (PENDING, IN_PROGRESS o IN_REVIEW) de un colaborador.
   *
   * Hay a lo sumo uno: lo garantiza el índice único parcial de la tabla.
   *
   * @param collaboratorId - Colaborador firmante.
   * @returns El intento abierto, o `null` si no hay ninguno.
   *
   * @example
   * ```ts
   * const active = await attemptService.findActive('col-1');
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
   * const latest = await attemptService.findLatest('col-1');
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
   * Busca un intento por la sesión de Didit que lo identifica.
   *
   * @param providerSessionId - `session_id` que trae el webhook.
   * @returns El intento de esa sesión, o `null` si la sesión no es de una firma biométrica.
   *
   * @example
   * ```ts
   * const attempt = await attemptService.findBySession('didit-session-1');
   * ```
   */
  findBySession(
    providerSessionId: string,
  ): Promise<BiometricSignatureAttemptEntity | null> {
    return this.attemptRepository.findOne({ where: { providerSessionId } });
  }

  /**
   * Indica si un intento sigue abierto en el tiempo: no venció según el `expires_at` de Didit.
   *
   * Sin vencimiento informado se considera vigente, igual que en la verificación de identidad: la
   * sesión se cierra por webhook (`Expired`) cuando Didit la da por vencida.
   *
   * @param attempt - Intento a evaluar.
   * @param now - Instante de referencia; por defecto, el actual.
   * @returns `true` si no tiene vencimiento o todavía no llega.
   *
   * @example
   * ```ts
   * attemptService.isUnexpired(attempt); // true
   * ```
   */
  isUnexpired(
    attempt: BiometricSignatureAttemptEntity,
    now: Date = new Date(),
  ): boolean {
    return !attempt.expiresAt || attempt.expiresAt.getTime() > now.getTime();
  }

  /**
   * Indica si la sesión de un intento se le puede devolver al firmante para continuar.
   *
   * Exige que esté abierto, que tenga URL hospedada, que no haya vencido y que el PDF siga siendo
   * el mismo que se aceptó al iniciarla. IN_REVIEW cuenta como abierto pero no se reabre: el
   * firmante ya terminó la prueba y sólo falta el veredicto.
   *
   * @param attempt - Intento abierto del colaborador.
   * @param currentDocumentHash - `original_hash` vigente del documento.
   * @returns `true` si la URL sigue sirviendo para esta firma.
   *
   * @example
   * ```ts
   * attemptService.isResumable(active, document.originalHash);
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
      (attempt.status === BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_REVIEW ||
        this.hostedUrl(attempt) !== null)
    );
  }

  /**
   * Arma la respuesta para el frontend a partir de un intento.
   *
   * La URL sólo se entrega mientras el intento esté abierto, no haya pasado a revisión y no haya
   * vencido.
   *
   * @param attempt - Intento a presentar.
   * @param options.reused - Si se devolvió una sesión existente en vez de crear otra.
   * @param options.signatureCompleted - Si el colaborador ya quedó firmado.
   * @param options.documentCompleted - Si el documento ya quedó firmado por todos; por defecto
   *   `false`.
   * @returns La sesión lista para serializar.
   *
   * @example
   * ```ts
   * attemptService.toSession(attempt, { reused: false, signatureCompleted: false });
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
      (attempt.status === BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING ||
        attempt.status ===
          BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.IN_PROGRESS) &&
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

  private hostedUrl(attempt: BiometricSignatureAttemptEntity): string | null {
    const url = attempt.providerMetadata?.hostedUrl;
    return typeof url === 'string' && url.length > 0 ? url : null;
  }
}
