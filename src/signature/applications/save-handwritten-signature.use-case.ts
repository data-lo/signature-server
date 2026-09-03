import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { SignatureCaptureSessionEntity } from '../entities/signature-capture-session.entity';
import { SIGNATURE_CAPTURE_CHANNEL_ENUM } from '../enums/signature-capture-channel.enum';
import { SIGNATURE_CAPTURE_SESSION_STATUS_ENUM } from '../enums/signature-capture-session-status.enum';
import {
  InvalidSignatureImageException,
  SignatureCaptureSessionNotUsableException,
} from '../exceptions/signature-capture.exceptions';
import { SignatureCaptureSessionStatus } from '../interfaces/signature-capture-session-status.interface';
import { isPngBuffer } from '../utils/png-file.util';
import { SignatureCaptureSessionService } from '../signature-capture-session.service';
import { UploadSignatureImageUseCase } from './upload-signature-image.use-case';

/**
 * Por qué una sesión ya no admite la firma. El mensaje dice qué pasó y qué hacer: al final de un
 * flujo que el usuario acaba de recorrer con el dedo en la pantalla, "409 Conflict" no explica
 * nada.
 */
const NOT_USABLE_REASON: Partial<
  Record<SIGNATURE_CAPTURE_SESSION_STATUS_ENUM, string>
> = {
  [SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.COMPLETED]:
    'Esta captura de firma ya se completó.',
  [SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.CANCELLED]:
    'Esta captura de firma se canceló. Inicia una nueva para registrar tu firma.',
  [SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.EXPIRED]:
    'Esta captura de firma venció. Inicia una nueva para registrar tu firma.',
  [SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.PENDING]:
    'Escanea el código QR con tu teléfono antes de enviar la firma.',
};

/**
 * Guarda el PNG que el usuario acaba de dibujar y cierra el intento
 * (`POST /api/v1/signature-capture-sessions/:id/signature`).
 *
 * **No reimplementa el alta de la firma**: la delega en `UploadSignatureImageUseCase`, el mismo que
 * atiende `PUT /api/v1/users/me/signature`, para que haya un solo camino hacia CONFIGURED y una sola
 * definición de qué significa registrar una firma, venga de un archivo subido desde la computadora o
 * de un canvas dibujado en el teléfono.
 *
 * Lo propio de acá es lo que rodea a esa alta: validar la sesión, comprobar que lo recibido es de
 * verdad un PNG y dejar constancia de qué intento produjo qué archivo.
 */
@Injectable()
export class SaveHandwrittenSignatureUseCase {
  private readonly logger = new Logger(SaveHandwrittenSignatureUseCase.name);

  constructor(
    @InjectRepository(SignatureCaptureSessionEntity)
    private readonly sessionRepository: Repository<SignatureCaptureSessionEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly sessions: SignatureCaptureSessionService,
    private readonly uploadSignatureImage: UploadSignatureImageUseCase,
  ) {}

  async execute(
    sessionId: string,
    userId: string,
    file: Express.Multer.File | undefined,
  ): Promise<BaseResponse<SignatureCaptureSessionStatus>> {
    // Lanza 404 si no existe, 403 si es de otro usuario y materializa el vencimiento.
    const session = await this.sessions.findOwnedById(sessionId, userId);

    this.assertUsable(session);
    this.assertPng(file);

    /**
     * El caso de uso compartido vuelve a comprobar que el usuario esté en SIGNATURE_PENDING,
     * sube el archivo a MinIO, crea la fila en `signatures`, la enlaza en `users.signature_id` y
     * mueve la credencial a CONFIGURED. Si algo de eso falla, la excepción sube y la sesión se
     * queda como estaba: es lo correcto, porque sin archivo guardado el intento no terminó y el
     * usuario todavía puede reintentar sobre la misma sesión mientras no venza.
     */
    const uploaded = await this.uploadSignatureImage.execute(
      userId,
      { signatureImage: file },
      { signatureImage: [file] },
    );

    const completedAt = new Date();

    await this.sessionRepository.update(session.id, {
      status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.COMPLETED,
      completedAt,
      signatureFileId: uploaded.data.id,
    });

    this.logger.log(
      `La captura de firma ${session.id} (canal ${session.channel}) produjo la firma ${uploaded.data.id} del usuario ${userId}.`,
    );

    /**
     * El estado de la credencial se relee en vez de darlo por CONFIGURED: es lo que la PC va a
     * pintar en cuanto su sondeo reciba esta misma información por `GET /:id`, y prefiero que
     * salga de la base a que salga de lo que este método supone que acaba de pasar.
     */
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    return {
      success: true,
      message: 'Firma registrada correctamente',
      data: this.sessions.toStatusResponse(
        {
          ...session,
          status: SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.COMPLETED,
          completedAt,
          signatureFileId: uploaded.data.id,
        },
        user.signingCredentialStatus,
      ),
    };
  }

  /**
   * En qué estado tiene que estar la sesión para aceptar la firma, según su canal.
   *
   * MOBILE_QR exige CLAIMED: sin ese paso previo, bastaría con conocer el `id` de la sesión para
   * mandar una firma, y el canje del token —que es donde se comprueba que el teléfono está
   * autenticado como el mismo usuario— quedaría de adorno. DESKTOP acepta PENDING porque ahí no
   * hay nada que canjear: la captura la hace el mismo navegador que abrió la sesión.
   */
  private assertUsable(session: SignatureCaptureSessionEntity): void {
    const expected =
      session.channel === SIGNATURE_CAPTURE_CHANNEL_ENUM.MOBILE_QR
        ? SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.CLAIMED
        : SIGNATURE_CAPTURE_SESSION_STATUS_ENUM.PENDING;

    if (session.status === expected) {
      return;
    }

    throw new SignatureCaptureSessionNotUsableException(
      NOT_USABLE_REASON[session.status] ??
        'Esta captura de firma ya no admite una firma nueva.',
    );
  }

  /**
   * Se acepta PNG y sólo PNG: es el formato con transparencia real que el canvas exporta y el
   * que el estampado de firmas espera encontrar más adelante. Un JPG con fondo blanco pasaría
   * desapercibido acá y aparecería como un recuadro opaco encima del documento firmado.
   *
   * La comprobación mira los bytes del archivo, no el `Content-Type` del multipart: esa cabecera
   * la escribe el cliente y dice lo que él quiera.
   */
  private assertPng(file: Express.Multer.File | undefined): void {
    if (!file) {
      throw new InvalidSignatureImageException(
        'No se recibió la imagen de la firma.',
      );
    }

    if (!isPngBuffer(file.buffer)) {
      throw new InvalidSignatureImageException(
        'La firma debe enviarse como una imagen PNG.',
      );
    }
  }
}
