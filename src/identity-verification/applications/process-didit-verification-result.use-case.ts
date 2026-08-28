import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { UpdateSigningCredentialStatusUseCase } from './update-signing-credential-status.use-case';

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
 * Qué significa cada resultado de Didit para el avance global del usuario.
 *
 * Rechazo, abandono, expiración y error del proveedor caen todos en RETRY_REQUIRED: desde el
 * lado del usuario los cuatro se resuelven igual, volviendo a intentar. El bloqueo definitivo
 * (`IDENTITY_VERIFICATION_FAILED`) no lo decide un webhook, sino la regla de intentos o una
 * intervención administrativa.
 *
 * APPROVED es el caso especial y se resuelve aparte, en `resolveCredentialTarget`.
 */
const CREDENTIAL_STATUS_BY_VERIFICATION_STATUS: Record<
  IDENTITY_VERIFICATION_STATUS_ENUM,
  SIGNING_CREDENTIAL_STATUS_ENUM
> = {
  [IDENTITY_VERIFICATION_STATUS_ENUM.PENDING]:
    SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_PENDING,
  [IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS]:
    SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_PROGRESS,
  [IDENTITY_VERIFICATION_STATUS_ENUM.IN_REVIEW]:
    SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_REVIEW,
  [IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED]:
    SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
  [IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED]:
    SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED,
  [IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED]:
    SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED,
  [IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED]:
    SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED,
  [IDENTITY_VERIFICATION_STATUS_ENUM.FAILED]:
    SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED,
};

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
    private readonly updateSigningCredentialStatus: UpdateSigningCredentialStatusUseCase,
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
     * Una aprobación gana siempre sobre un estado terminal que NO es aprobación.
     *
     * El caso real: la sesión expira (o se abandona) y Didit emite ese evento, pero el usuario sí
     * completó la verificación y el `Approved` llega después — el proveedor no garantiza el orden
     * de entrega. Sin esta excepción, la aprobación chocaba con la guarda de abajo y se descartaba
     * en silencio: el intento se quedaba en EXPIRED, el usuario en RETRY_REQUIRED y la pantalla le
     * mostraba "la sesión de verificación expiró" pese a haberla completado, sin forma de avanzar.
     *
     * Es seguro porque `Approved` es un hecho verificado y firmado por el proveedor, no una
     * suposición nuestra: que la URL ya se hubiera consumido describe al canal, no al veredicto.
     */
    const supersedesTerminal =
      status === IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED &&
      attempt.status !== IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED;

    /**
     * Didit no garantiza el orden de entrega: un `In Progress` retrasado puede llegar después
     * del `Approved`. Sin esta guarda, ese reordenamiento degradaría una identidad ya aprobada
     * y le quitaría al usuario la posibilidad de firmar.
     */
    if (
      TERMINAL_STATUSES.includes(attempt.status) &&
      attempt.status !== status &&
      !supersedesTerminal
    ) {
      this.logger.warn(
        `Se ignora el estado ${status} para la sesión ${sessionId}: el intento ya está en ${attempt.status}.`,
      );
      return;
    }

    if (supersedesTerminal && TERMINAL_STATUSES.includes(attempt.status)) {
      this.logger.log(
        `La sesión ${sessionId} estaba en ${attempt.status} y Didit la aprobó después: se aplica la aprobación.`,
      );
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
     * El estado global se mueve en todos los resultados, no sólo al aprobar: si un intento
     * aprobado termina en EXPIRED, la credencial de firma tiene que dejar de valer por la misma
     * vía por la que se otorgó.
     *
     * `applyIfAllowed` y no `execute`: Didit reentrega webhooks y no garantiza el orden, así
     * que una transición imposible es un evento viejo, no un fallo del servidor. Devolver 500
     * haría que el proveedor reintentara para siempre.
     */
    if (status === IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED) {
      await this.applyApproval(attempt.userId);
    } else {
      await this.updateSigningCredentialStatus.applyIfAllowed(
        attempt.userId,
        CREDENTIAL_STATUS_BY_VERIFICATION_STATUS[status],
      );
    }

    this.logger.log(
      `Verificación ${attempt.id} (sesión ${sessionId}) actualizada a ${status}.`,
    );
  }

  /**
   * Lleva la credencial hasta donde corresponde tras una aprobación.
   *
   * Quien ya tenía su rúbrica registrada —el usuario que subió su firma con el onboarding
   * anterior a Didit y valida su identidad después— termina en CONFIGURED; el resto, en
   * SIGNATURE_PENDING, que es lo único que le falta.
   *
   * **Se recorre en pasos en vez de apuntar directo a CONFIGURED.** La máquina de estados no es
   * sólo una descripción: es también la autorización de los demás disparadores, y hay uno
   * (`UpdateSignatureUseCase`) que pide CONFIGURED al reponer la rúbrica sin comprobar la
   * identidad, confiando en que la transición quede en no-op. Abrir
   * PENDING/IN_PROGRESS/IN_REVIEW → CONFIGURED para que la aprobación llegara de un salto le
   * daría de paso credencial completa a quien no tiene identidad aprobada. Los dos pasos que se
   * dan aquí ya eran aristas válidas, así que nadie más gana permisos.
   */
  private async applyApproval(userId: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    /**
     * Desde RETRY_REQUIRED la única salida es PENDING: es el caso de la aprobación que llega
     * después de que Didit diera la sesión por expirada o abandonada. Se da ese paso primero
     * para no pedir una transición ilegal (que sólo dejaría un warning y ningún cambio).
     */
    if (
      user?.signingCredentialStatus ===
      SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED
    ) {
      await this.updateSigningCredentialStatus.applyIfAllowed(
        userId,
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_PENDING,
      );
    }

    await this.updateSigningCredentialStatus.applyIfAllowed(
      userId,
      SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
    );

    if (user?.signatureId) {
      await this.updateSigningCredentialStatus.applyIfAllowed(
        userId,
        SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
      );
    }
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
