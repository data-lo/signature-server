import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SigningCredentialNotReadyException } from 'src/identity-verification/exceptions/identity-verification.exceptions';
import { SignatureCaptureSessionEntity } from '../entities/signature-capture-session.entity';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';
import {
  InvalidSignatureCaptureTokenException,
  SignatureCaptureSessionForbiddenException,
} from '../exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionStatus } from '../interfaces/signature-capture-session-status.interface';
import { SIGNING_CREDENTIAL_BLOCK_REASON } from '../constants/signing-credential-block-reason';
import { SignatureCaptureSessionService } from '../signature-capture-session.service';

/**
 * Canjea desde el teléfono el token del QR (`POST /api/v1/signature-capture-sessions/claim`).
 *
 * Es el paso que ata el intento a un dispositivo concreto y donde se comprueba la regla que hace
 * seguro el flujo PC ↔ teléfono: **quien escanea tiene que estar autenticado como el mismo usuario
 * que generó el código**. El token por sí solo no basta, porque un QR en pantalla es visible para
 * cualquiera que pase y fotografiable sin dejar rastro.
 *
 * Reclamar es de un solo uso por construcción y sin borrar nada: la sesión sale de PENDING, que es el
 * único estado desde el que se puede reclamar.
 */
@Injectable()
export class ClaimMobileSignatureSessionUseCase {
  private readonly logger = new Logger(ClaimMobileSignatureSessionUseCase.name);

  constructor(
    @InjectRepository(SignatureCaptureSessionEntity)
    private readonly sessionRepository: Repository<SignatureCaptureSessionEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly sessions: SignatureCaptureSessionService,
  ) {}

  async execute(
    userId: string,
    token: string,
  ): Promise<SignatureCaptureSessionStatus> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    const session = await this.sessions.findByToken(token);

    /**
     * La comprobación de dueño va antes que la de estado, y con su propio 403: al usuario que
     * abrió el QR con la cuenta equivocada en el teléfono —el celular de la casa, la sesión de
     * otro familiar— hay que decirle qué le pasó. "El código ya no es válido" lo mandaría a
     * generar otro y a chocar con lo mismo.
     */
    if (session.userId !== userId) {
      this.logger.warn(
        `El usuario ${userId} intentó reclamar la captura ${session.id}, que pertenece a ${session.userId}.`,
      );
      throw new SignatureCaptureSessionForbiddenException();
    }

    /**
     * Una sesión DESKTOP no tiene token, así que no debería poder llegar acá por hash; se
     * comprueba igual porque el canal es lo que decide qué pasos exige el intento, y dejarlo
     * implícito haría que un cambio futuro en la emisión de tokens abriera un atajo silencioso.
     */
    if (session.channel !== SIGNATURE_CAPTURE_CHANNEL_ENUM.MOBILE_QR) {
      throw new InvalidSignatureCaptureTokenException();
    }

    /**
     * Ya reclamada, completada, cancelada o vencida: todas dan el mismo error opaco. Al portador
     * legítimo le sirve igual —lo que tiene que hacer es generar otro QR— y a un tercero no le
     * confirma nada sobre el token que tiene en la mano.
     */
    if (session.status !== SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.PENDING) {
      throw new InvalidSignatureCaptureTokenException();
    }

    /**
     * El estado del usuario se vuelve a mirar acá y no sólo al crear la sesión: entre que se
     * generó el QR y se escaneó pudo pasar cualquier cosa con su credencial de firma.
     */
    if (
      user.signingCredentialStatus !==
      SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING
    ) {
      throw new SigningCredentialNotReadyException(
        SIGNING_CREDENTIAL_BLOCK_REASON[user.signingCredentialStatus],
      );
    }

    const claimedAt = new Date();

    await this.sessionRepository.update(session.id, {
      status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.CLAIMED,
      claimedAt,
    });

    this.logger.log(
      `El usuario ${userId} reclamó la captura de firma ${session.id} desde su teléfono.`,
    );

    return this.sessions.toStatusResponse(
      {
        ...session,
        status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.CLAIMED,
        claimedAt,
      },
      user.signingCredentialStatus,
    );
  }
}
