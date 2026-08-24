import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SignatureCaptureSessionEntity } from '../entities/signature-capture-session.entity';
import {
  ACTIVE_SIGNATURE_CAPTURE_STATUSES,
  SIGNATURE_CAPTURE_SESSION_STATUS_ENUM,
} from '../enums/signature-capture-session-status.enum';
import { SignatureCaptureSessionNotUsableException } from '../exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionStatus } from '../interfaces/signature-capture-session-status.interface';
import { SignatureCaptureSessionService } from '../signature-capture-session.service';

/**
 * `POST /api/v1/signature-capture-sessions/:id/cancel`: el usuario abandona el intento.
 *
 * Cancelar invalida el QR en el acto —una sesión CANCELLED no se reclama ni acepta firmas— y
 * libera al usuario para abrir otro intento sin esperar a que venzan los diez minutos. Es la
 * salida que necesita quien cambió de idea, quien dejó el código a la vista y prefiere rotarlo,
 * o quien tiene una captura reclamada en un teléfono que ya no tiene a mano.
 */
@Injectable()
export class CancelSignatureCaptureSessionUseCase {
  private readonly logger = new Logger(
    CancelSignatureCaptureSessionUseCase.name,
  );

  constructor(
    @InjectRepository(SignatureCaptureSessionEntity)
    private readonly sessionRepository: Repository<SignatureCaptureSessionEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly sessions: SignatureCaptureSessionService,
  ) {}

  async execute(
    sessionId: string,
    userId: string,
  ): Promise<SignatureCaptureSessionStatus> {
    const session = await this.sessions.findOwnedById(sessionId, userId);
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    /**
     * Una firma ya registrada no se deshace cancelando el intento que la produjo: para eso está
     * el borrado de la firma, que además devuelve al usuario a SIGNATURE_PENDING. Si cancelar
     * "funcionara" acá, el historial diría que el intento no llegó a nada mientras el PNG sigue
     * siendo la firma vigente del usuario.
     */
    if (session.status === SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.COMPLETED) {
      throw new SignatureCaptureSessionNotUsableException(
        'Esta captura de firma ya se completó y no puede cancelarse.',
      );
    }

    /**
     * Cancelar algo ya cancelado o vencido no es un error: el intento está muerto, que es
     * exactamente el resultado pedido. Devolver 409 sólo obligaría a la pantalla a distinguir
     * entre dos formas de "ya no hay nada que cancelar" para tratarlas igual.
     */
    if (!ACTIVE_SIGNATURE_CAPTURE_STATUSES.includes(session.status)) {
      return this.sessions.toStatusResponse(
        session,
        user.signingCredentialStatus,
      );
    }

    await this.sessionRepository.update(session.id, {
      status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.CANCELLED,
    });

    this.logger.log(
      `El usuario ${userId} canceló la captura de firma ${session.id} (estaba en ${session.status}).`,
    );

    return this.sessions.toStatusResponse(
      {
        ...session,
        status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.CANCELLED,
      },
      user.signingCredentialStatus,
    );
  }
}
