import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SigningCredentialNotReadyException } from 'src/identity-verification/exceptions/identity-verification.exceptions';
import { frontendBaseUrl } from 'src/shared/utils/frontend-url.util';
import { SignatureCaptureSessionEntity } from '../entities/signature-capture-session.entity';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';
import { SignatureCaptureSessionInProgressException } from '../exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionCreated } from '../interfaces/signature-capture-session-created.interface';
import { SIGNING_CREDENTIAL_BLOCK_REASON } from '../constants/signing-credential-block-reason';
import { SIGNATURE_CAPTURE_MOBILE_PATH } from '../constants/signature-capture.constants';
import {
  generateSignatureCaptureToken,
  hashSignatureCaptureToken,
} from '../utils/signature-capture-token.util';
import { SignatureCaptureSessionService } from '../signature-capture-session.service';

/** Código de Postgres para violación de restricción única. */
const UNIQUE_VIOLATION = '23505';

/**
 * `POST /api/v1/signature-capture-sessions`: abre un intento de captura de la firma manuscrita.
 *
 * Acá se aplica la primera regla del flujo —sólo un usuario con la identidad ya aprobada por
 * Didit (SIGNATURE_PENDING) puede empezar— y se emite, cuando el canal es MOBILE_QR, el token de
 * un solo uso que viaja dentro del código.
 */
@Injectable()
export class CreateSignatureCaptureSessionUseCase {
  private readonly logger = new Logger(
    CreateSignatureCaptureSessionUseCase.name,
  );

  constructor(
    @InjectRepository(SignatureCaptureSessionEntity)
    private readonly sessionRepository: Repository<SignatureCaptureSessionEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly sessions: SignatureCaptureSessionService,
  ) {}

  async execute(
    userId: string,
    channel: SIGNATURE_CAPTURE_CHANNEL_ENUM,
  ): Promise<SignatureCaptureSessionCreated> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    /**
     * Misma regla y mismo mensaje que `UploadSignatureImageUseCase`: la firma sólo se acepta con
     * la identidad aprobada. Se comprueba ya al abrir la sesión —y no sólo al recibir el PNG—
     * para no pasear al usuario hasta el canvas, o hasta el teléfono, y rechazarlo al final.
     */
    if (
      user.signingCredentialStatus !==
      SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING
    ) {
      throw new SigningCredentialNotReadyException(
        SIGNING_CREDENTIAL_BLOCK_REASON[user.signingCredentialStatus],
      );
    }

    const active = await this.sessions.findActiveForUser(userId);

    if (active) {
      const reusable = this.resolveActiveSession(active, channel);

      if (reusable) {
        return this.toCreatedResponse(reusable, null, true);
      }
    }

    return this.openSession(userId, channel);
  }

  /**
   * Qué hacer con la sesión que el usuario ya tenía abierta.
   *
   * @returns La sesión a devolver tal cual, o `null` si hay que abrir una nueva.
   */
  private resolveActiveSession(
    active: SignatureCaptureSessionEntity,
    channel: SIGNATURE_CAPTURE_CHANNEL_ENUM,
  ): SignatureCaptureSessionEntity | null {
    /**
     * Reclamada quiere decir que hay un teléfono con el canvas abierto ahora mismo. Sustituirla
     * en silencio —porque el usuario volvió a pulsar "Generar QR", o recargó la pestaña de la
     * PC— dejaría muerto ese envío justo antes de terminar. Se le pide que decida.
     */
    if (active.status === SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.CLAIMED) {
      throw new SignatureCaptureSessionInProgressException();
    }

    /**
     * Misma pantalla, mismo canal, nadie la ha usado todavía: es un reintento, no una captura
     * nueva. Se devuelve la que ya existe para que el `id` que la PC está sondeando siga valiendo.
     *
     * Con MOBILE_QR no se puede hacer lo mismo: el token en claro no se guardó, así que no hay
     * forma de recomponer el QR de esa sesión. Pedir el código otra vez rota el token, y eso es
     * justamente lo que corresponde — el anterior queda inservible.
     */
    if (
      active.channel === channel &&
      channel === SIGNATURE_CAPTURE_CHANNEL_ENUM.DESKTOP
    ) {
      return active;
    }

    return null;
  }

  private async openSession(
    userId: string,
    channel: SIGNATURE_CAPTURE_CHANNEL_ENUM,
  ): Promise<SignatureCaptureSessionCreated> {
    const token =
      channel === SIGNATURE_CAPTURE_CHANNEL_ENUM.MOBILE_QR
        ? generateSignatureCaptureToken()
        : null;

    try {
      /**
       * Cancelar la anterior y crear la nueva van en la misma transacción. Separadas, un proceso
       * que muriera en medio dejaría al usuario sin ninguna sesión activa y con la vieja ya
       * cancelada: nada roto en base, pero un flujo que hay que reiniciar sin saber por qué.
       */
      const session = await this.sessionRepository.manager.transaction(
        async (manager) => {
          await manager.update(
            SignatureCaptureSessionEntity,
            { userId, status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.PENDING },
            { status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.CANCELLED },
          );

          return manager.save(
            manager.create(SignatureCaptureSessionEntity, {
              userId,
              channel,
              status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.PENDING,
              tokenHash: token ? hashSignatureCaptureToken(token) : null,
              expiresAt: this.sessions.buildExpiresAt(),
            }),
          );
        },
      );

      this.logger.log(
        `Captura de firma ${session.id} abierta para el usuario ${userId} por canal ${channel}.`,
      );

      return this.toCreatedResponse(session, token, false);
    } catch (error) {
      /**
       * El índice único parcial es la última palabra sobre "una sola sesión activa por usuario".
       * Se llega acá cuando dos peticiones del mismo usuario entran a la vez —doble clic, dos
       * pestañas— y ambas pasaron la comprobación en memoria: la que pierde la carrera se topa
       * con la fila que acaba de insertar la otra, y su usuario recibe el mismo 409 que si
       * hubiera una captura en curso, que es exactamente lo que hay.
       */
      if (this.isActiveSessionConflict(error)) {
        this.logger.warn(
          `Carrera al abrir una captura de firma para el usuario ${userId}: ya había otra activa.`,
        );
        throw new SignatureCaptureSessionInProgressException();
      }

      throw error;
    }
  }

  private isActiveSessionConflict(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error as QueryFailedError & { driverError?: { code?: string } })
        .driverError?.code === UNIQUE_VIOLATION
    );
  }

  private toCreatedResponse(
    session: SignatureCaptureSessionEntity,
    token: string | null,
    reused: boolean,
  ): SignatureCaptureSessionCreated {
    return {
      id: session.id,
      channel: session.channel,
      status: session.status,
      expiresAt: session.expiresAt,
      token,
      qrUrl: token ? this.buildQrUrl(token) : null,
      reused,
    };
  }

  /**
   * La URL que se convierte en QR apunta al frontend, no a la API: lo que el teléfono necesita
   * abrir es la pantalla con el canvas, que después canjea el token contra el backend. El token
   * viaja como query param —pasado por `encodeURIComponent` de todos modos, aunque `base64url`
   * no produzca caracteres que haya que escapar— y es lo único variable del enlace.
   */
  private buildQrUrl(token: string): string {
    const query = new URLSearchParams({ token }).toString();

    return `${frontendBaseUrl()}${SIGNATURE_CAPTURE_MOBILE_PATH}?${query}`;
  }
}
