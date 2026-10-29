import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SignatureCaptureSessionEntity } from './entities/signature-capture-session.entity';
import {
  ACTIVE_SIGNATURE_CAPTURE_STATUSES,
  SIGNATURE_CAPTURE_SESSION_STATUS_ENUM,
} from './enums/signature-capture-session-status.enum';
import {
  InvalidSignatureCaptureTokenException,
  SignatureCaptureSessionForbiddenException,
} from './exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionStatus } from './interfaces/signature-capture-session-status.interface';
import { SIGNATURE_CAPTURE_SESSION_TTL_MINUTES } from './constants/signature-capture.constants';
import { hashSignatureCaptureToken } from './utils/signature-capture-token.util';

/**
 * Mecánica compartida de las sesiones de captura: buscarlas, materializar su vencimiento y
 * comprobar de quién son.
 *
 * Es el equivalente de `SignatureService` para esta tabla — trabajo técnico, ninguna regla de
 * negocio. Quién puede abrir una captura, qué exige cada canal y qué significa completarla vive
 * en los casos de uso de `applications/`; acá sólo está lo que los cinco necesitan hacer igual,
 * que es precisamente lo que no puede divergir: si un endpoint materializara el vencimiento y
 * otro no, el mismo QR estaría vencido o vivo según por dónde se lo mirara.
 */
@Injectable()
export class SignatureCaptureSessionService {
  private readonly logger = new Logger(SignatureCaptureSessionService.name);

  constructor(
    @InjectRepository(SignatureCaptureSessionEntity)
    private readonly sessionRepository: Repository<SignatureCaptureSessionEntity>,
  ) {}

  /** Vencimiento de una sesión que se crea ahora. */
  buildExpiresAt(from: Date = new Date()): Date {
    return new Date(
      from.getTime() + SIGNATURE_CAPTURE_SESSION_TTL_MINUTES * 60 * 1000,
    );
  }

  /**
   * La sesión viva del usuario, si la tiene.
   *
   * Devuelve `null` cuando la única que había ya venció, porque antes de decidirlo la marca
   * EXPIRED en base: sin eso, el índice único parcial seguiría viendo una fila PENDING y
   * bloquearía la creación de la siguiente para siempre.
   */
  async findActiveForUser(
    userId: string,
  ): Promise<SignatureCaptureSessionEntity | null> {
    const session = await this.sessionRepository.findOne({
      where: {
        userId,
        status: In([...ACTIVE_SIGNATURE_CAPTURE_STATUSES]),
      },
      order: { createdAt: 'DESC' },
    });

    if (!session) {
      return null;
    }

    const refreshed = await this.expireIfDue(session);

    return this.isActive(refreshed) ? refreshed : null;
  }

  /**
   * Una sesión por su id, comprobando que sea del usuario autenticado.
   *
   * El orden importa: primero "existe", después "es tuya". Contestar 403 sobre un id inventado
   * confirmaría a un tercero qué identificadores son reales.
   */
  async findOwnedById(
    id: string,
    userId: string,
  ): Promise<SignatureCaptureSessionEntity> {
    const session = await this.sessionRepository.findOne({ where: { id } });

    if (!session) {
      throw new NotFoundException(
        `No existe una captura de firma con id ${id}.`,
      );
    }

    /**
     * La comparación es contra el `userId` de la fila, que se escribió desde el token de quien
     * la creó. Ni el path, ni el cuerpo, ni el QR pueden cambiarlo: es lo que impide que quien
     * fotografíe el código termine registrando una firma en cuenta ajena.
     */
    if (session.userId !== userId) {
      this.logger.warn(
        `El usuario ${userId} intentó operar sobre la captura ${id}, que pertenece a ${session.userId}.`,
      );
      throw new SignatureCaptureSessionForbiddenException();
    }

    return this.expireIfDue(session);
  }

  /**
   * La sesión que corresponde a un token de QR.
   *
   * La búsqueda es por hash: el token en claro no existe en base, así que ni siquiera un volcado
   * completo permite canjear uno. Que el token sea de un solo uso no se implementa borrándolo,
   * sino con el estado — al reclamarlo la sesión pasa a CLAIMED y deja de ser reclamable.
   */
  async findByToken(token: string): Promise<SignatureCaptureSessionEntity> {
    const session = await this.sessionRepository.findOne({
      where: { tokenHash: hashSignatureCaptureToken(token) },
    });

    if (!session) {
      throw new InvalidSignatureCaptureTokenException();
    }

    return this.expireIfDue(session);
  }

  /**
   * Vencimiento perezoso: la sesión pasa a EXPIRED la primera vez que alguien la mira después
   * de su hora.
   *
   * No hace falta una tarea programada que barra la tabla. Una sesión vencida sólo estorba
   * cuando se la consulta o cuando su dueño quiere abrir otra, y en ambos momentos se pasa por
   * acá; una tarea periódica agregaría una pieza en movimiento para adelantar un cambio que a
   * nadie le consta hasta que lo consulta.
   */
  private async expireIfDue(
    session: SignatureCaptureSessionEntity,
  ): Promise<SignatureCaptureSessionEntity> {
    if (!this.isActive(session) || session.expiresAt.getTime() > Date.now()) {
      return session;
    }

    await this.sessionRepository.update(session.id, {
      status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.EXPIRED,
    });

    this.logger.log(
      `La captura de firma ${session.id} venció sin completarse (canal ${session.channel}).`,
    );

    return {
      ...session,
      status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.EXPIRED,
    };
  }

  private isActive(session: SignatureCaptureSessionEntity): boolean {
    return ACTIVE_SIGNATURE_CAPTURE_STATUSES.includes(session.status);
  }

  toStatusResponse(
    session: SignatureCaptureSessionEntity,
    signingCredentialStatus: SIGNING_CREDENTIAL_STATUS_ENUM,
  ): SignatureCaptureSessionStatus {
    return {
      id: session.id,
      channel: session.channel,
      status: session.status,
      expiresAt: session.expiresAt,
      claimedAt: session.claimedAt,
      completedAt: session.completedAt,
      signatureId: session.signatureFileId,
      signingCredentialStatus,
    };
  }
}
