import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';

import { FinalizeBiometricSignatureCreditsUseCase } from 'src/billing/credits/finalize-biometric-signature-credits.use-case';
import { ReserveBiometricSignatureCreditsUseCase } from 'src/billing/credits/reserve-biometric-signature-credits.use-case';
import type { GeolocationDto } from 'src/document/dto/sign-document.dto';
import { collaboratorEmail } from 'src/document/utils/collaborator-display.util';
import { DiditSession } from 'src/identity-verification/interfaces/didit-session.interface';

import { BiometricSignatureAttemptEntity } from '../entities/biometric-signature-attempt.entity';
import { BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM } from '../enums/biometric-signature-attempt-status.enum';
import { BIOMETRIC_SIGNATURE_PROVIDER_ENUM } from '../enums/biometric-signature-provider.enum';
import { BiometricSignatureSession } from '../interfaces/biometric-signature-session.interface';
import {
  BiometricSignatureDiditService,
  BiometricSignerKind,
} from '../didit/biometric-signature-didit.service';
import { BiometricSignatureAttemptService } from './biometric-signature-attempt.service';
import { ResolvedBiometricSigner } from './biometric-signer.service';

const UNIQUE_VIOLATION = '23505';

/** Lo que distingue el lanzamiento de un firmante con cuenta del de un invitado. */
export interface BiometricLaunchParams {
  resolved: ResolvedBiometricSigner;
  kind: BiometricSignerKind;
  /** Usuario autenticado; `null` para invitados. */
  userId: string | null;
  /** Identidad aprobada (id local y `session_id` de Didit); `null` para invitados. */
  identity: { id: string; providerSessionId: string } | null;
  geolocation: GeolocationDto;
  ipAddress: string | null;
  /** Pantalla a la que Didit regresa al firmante. Sólo navegación. */
  callbackUrl: string;
}

/**
 * Abre —o retoma— la sesión de Didit de una firma biométrica. Es el núcleo común de
 * `StartAccountBiometricSignatureUseCase` y `StartGuestBiometricSignatureUseCase`; cada uno valida
 * a su firmante antes de llamar aquí.
 *
 * Garantías:
 * - **Una recarga no abre otra sesión**: si hay un intento abierto, vigente y sobre el mismo PDF,
 *   se devuelve (`reused: true`). Uno abierto que dejó de servir se cierra antes de abrir otro.
 * - **El intento se persiste ANTES de llamar a Didit**, así el webhook siempre tiene contra qué
 *   reconciliar.
 * - **Sin crédito biométrico no hay sesión**: tras crear el intento se reserva un crédito
 *   (`ReserveBiometricSignatureCreditsUseCase`); sin saldo, el intento queda en FAILED y Didit no se
 *   llama. Si Didit no crea la sesión, o un intento abierto se cierra por inservible, la reserva se
 *   libera.
 * - **Dos clics simultáneos no abren dos sesiones**: el índice único parcial (colaborador + hash)
 *   rechaza el segundo `INSERT` y se devuelve la sesión del primero.
 */
@Injectable()
export class BiometricSessionLauncherService {
  private readonly logger = new Logger(BiometricSessionLauncherService.name);

  constructor(
    @InjectRepository(BiometricSignatureAttemptEntity)
    private readonly attemptRepository: Repository<BiometricSignatureAttemptEntity>,
    private readonly attempts: BiometricSignatureAttemptService,
    private readonly didit: BiometricSignatureDiditService,
    private readonly reserveCredits: ReserveBiometricSignatureCreditsUseCase,
    private readonly finalizeCredits: FinalizeBiometricSignatureCreditsUseCase,
  ) {}

  /**
   * Devuelve la sesión de Didit con la que el firmante autoriza su firma, reutilizando la abierta si
   * sirve.
   *
   * @param params - Firmante ya validado y datos del intento.
   * @returns La sesión: URL hospedada, estado y si se reutilizó.
   *
   * @throws {DiditConfigurationException} Si falta el workflow del tipo de firmante.
   * @throws {ConflictException} Si otra petición abrió una sesión a la vez y ya no hay qué devolver.
   * @throws {BiometricReferencePortraitUnavailableException} Si el firmante con cuenta no tiene
   *   retrato de referencia utilizable (el intento queda en FAILED).
   * @throws {DiditResponseException} Si Didit no pudo crear la sesión (el intento queda en FAILED y
   *   su crédito biométrico se libera).
   * @throws {InsufficientBiometricCreditsException} (402) Si el documento no tiene crédito
   *   biométrico disponible (el intento queda en FAILED y Didit no se llama).
   *
   * @example
   * ```ts
   * const session = await launcher.launch({ resolved, kind: 'GUEST', userId: null, identity: null, … });
   * ```
   */
  async launch(
    params: BiometricLaunchParams,
  ): Promise<BiometricSignatureSession> {
    const { document, signer } = params.resolved;

    const active = await this.attempts.findActive(signer.id);
    if (active) {
      if (this.attempts.isResumable(active, document.originalHash)) {
        // Mismo intento, misma reserva: la reserva es idempotente por intento y no bloquea otro
        // crédito. Sólo un intento abierto antes de las reservas reserva aquí por primera vez.
        await this.reserveCredits.execute({
          biometricSignatureAttemptId: active.id,
          documentId: document.id,
        });
        // Sin la URL en el log: es la puerta a la sesión del firmante.
        this.logger.log(
          `Reutilizando el intento biométrico ${active.id} del colaborador ${signer.id}.`,
        );
        return this.attempts.toSession(active, {
          reused: true,
          signatureCompleted: false,
        });
      }
      await this.closeUnusable(active, document.originalHash);
      await this.releaseCredits(active.id, 'ATTEMPT_CLOSED_UNUSABLE');
    }

    const workflowId = this.didit.workflowFor(params.kind);
    const created = await this.createAttempt(params, workflowId);
    if (created.reusedSession) {
      return created.reusedSession;
    }
    const attempt = created.entity;

    // Sin crédito biométrico no se abre la sesión: Didit cobra cada sesión creada.
    try {
      await this.reserveCredits.execute({
        biometricSignatureAttemptId: attempt.id,
        documentId: document.id,
      });
    } catch (error) {
      await this.attemptRepository.update(attempt.id, {
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason:
          'No se pudo reservar el crédito de firma biométrica del documento',
        completedAt: new Date(),
      });
      throw error;
    }

    let session: DiditSession;
    try {
      session =
        params.kind === 'ACCOUNT'
          ? await this.didit.openAccountSession({
              attemptId: attempt.id,
              workflowId,
              callbackUrl: params.callbackUrl,
              identitySessionId: params.identity.providerSessionId,
            })
          : await this.didit.openGuestSession({
              attemptId: attempt.id,
              workflowId,
              callbackUrl: params.callbackUrl,
            });
    } catch (error) {
      // El intento no se borra: queda en FAILED con el motivo, como rastro consultable.
      await this.attemptRepository.update(attempt.id, {
        status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason:
          error instanceof Error ? error.message : 'Error desconocido',
        completedAt: new Date(),
      });
      await this.releaseCredits(attempt.id, 'DIDIT_SESSION_NOT_CREATED');
      throw error;
    }

    await this.attemptRepository.update(attempt.id, {
      providerSessionId: session.sessionId,
      providerMetadata: { ...session.raw, hostedUrl: session.url },
      startedAt: new Date(),
      expiresAt: session.expiresAt,
    });

    return this.attempts.toSession(
      await this.attemptRepository.findOneByOrFail({ id: attempt.id }),
      { reused: false, signatureCompleted: false },
    );
  }

  /**
   * Cierra un intento abierto que ya no puede retomarse (venció, el PDF cambió o se quedó sin
   * URL), para liberar el índice. Condicionado al estado leído para no pisar un webhook.
   *
   * @param attempt - Intento abierto que ya no sirve.
   * @param currentDocumentHash - `original_hash` vigente.
   * @returns Nada.
   *
   * @throws {QueryFailedError} Si falla la escritura.
   *
   * @example
   * ```ts
   * await this.closeUnusable(active, document.originalHash);
   * ```
   */
  private async closeUnusable(
    attempt: BiometricSignatureAttemptEntity,
    currentDocumentHash: string,
  ): Promise<void> {
    const expired = !this.attempts.isUnexpired(attempt);
    const documentChanged = attempt.documentHash !== currentDocumentHash;

    await this.attemptRepository.update(
      { id: attempt.id, status: attempt.status },
      {
        status: expired
          ? BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.EXPIRED
          : BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.FAILED,
        failureReason: expired
          ? 'La sesión de Didit venció antes de completarse'
          : documentChanged
            ? 'El documento cambió después de iniciar la sesión biométrica'
            : 'La sesión de Didit quedó sin URL utilizable',
        completedAt: new Date(),
      },
    );
  }

  /**
   * Inserta el intento en PENDING. Si otra petición del mismo colaborador ganó la carrera, devuelve
   * la sesión de la ganadora.
   *
   * Objeto con dos campos nulables y no una unión discriminada: el proyecto compila sin
   * `strictNullChecks`, y ahí TypeScript no estrecha uniones por un discriminante booleano.
   *
   * @param params - Datos del lanzamiento.
   * @param workflowId - Workflow ya resuelto.
   * @returns El intento creado, o la sesión de la petición ganadora.
   *
   * @throws {ConflictException} Si choca y no hay intento abierto que devolver.
   * @throws {QueryFailedError} Cualquier otro error de la base.
   *
   * @example
   * ```ts
   * const { entity, reusedSession } = await this.createAttempt(params, 'wf-kyc');
   * ```
   */
  private async createAttempt(
    params: BiometricLaunchParams,
    workflowId: string,
  ): Promise<{
    entity: BiometricSignatureAttemptEntity | null;
    reusedSession: BiometricSignatureSession | null;
  }> {
    const { document, signer } = params.resolved;

    try {
      const entity = await this.attemptRepository.save(
        this.attemptRepository.create({
          documentId: document.id,
          collaboratorId: signer.id,
          userId: params.userId,
          emailSnapshot: collaboratorEmail(signer),
          identityVerificationId: params.identity?.id ?? null,
          provider: BIOMETRIC_SIGNATURE_PROVIDER_ENUM.DIDIT,
          providerWorkflowId: workflowId,
          documentHash: document.originalHash,
          status: BIOMETRIC_SIGNATURE_ATTEMPT_STATUS_ENUM.PENDING,
          geolocation: { ...params.geolocation },
          ipAddress: params.ipAddress,
          consentedAt: new Date(),
        }),
      );
      return { entity, reusedSession: null };
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      const winner = await this.attempts.findActive(signer.id);
      if (!winner) {
        throw new ConflictException(
          'Se está iniciando otra sesión biométrica para esta firma. Inténtalo de nuevo.',
        );
      }

      return {
        entity: null,
        reusedSession: this.attempts.toSession(winner, {
          reused: true,
          signatureCompleted: false,
        }),
      };
    }
  }

  /**
   * Devuelve al saldo el crédito biométrico de un intento que terminó sin firma. Un fallo aquí no
   * oculta el error original del lanzamiento: la reserva vence y la recoge el job de reservas.
   *
   * @param attemptId - Intento cerrado.
   * @param reason - Motivo para el ledger.
   * @returns Nada.
   *
   * @example
   * ```ts
   * await this.releaseCredits(attempt.id, 'DIDIT_SESSION_NOT_CREATED');
   * ```
   */
  private async releaseCredits(
    attemptId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.finalizeCredits.onAttemptFailed({
        biometricSignatureAttemptId: attemptId,
        reason,
      });
    } catch (error) {
      this.logger.error(
        `No se pudo liberar el crédito biométrico del intento ${attemptId}: ${error}`,
      );
    }
  }

  /**
   * Indica si el error es una violación de unicidad de Postgres (23505).
   *
   * @param error - Error de TypeORM.
   * @returns `true` si lo es.
   *
   * @example
   * ```ts
   * this.isUniqueViolation(error); // true
   * ```
   */
  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION
    );
  }
}
