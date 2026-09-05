import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SignatureCaptureSessionStatus } from '../interfaces/signature-capture-session-status.interface';
import { SignatureCaptureSessionService } from '../signature-capture-session.service';

/**
 * Informa en qué va el intento (`GET /api/v1/signature-capture-sessions/:id`).
 *
 * Es el endpoint que la PC consulta en bucle mientras el usuario firma en el teléfono, y lo que hace
 * que la pantalla pase sola a "firma registrada" sin reiniciar el flujo. Por eso la respuesta trae
 * también `signingCredentialStatus`: con una sola petición la PC sabe que el intento terminó y que
 * la credencial ya quedó CONFIGURED.
 *
 * Consultar además materializa el vencimiento, así que la PC se entera de que su QR caducó por el
 * mismo sondeo con el que espera la firma.
 */
@Injectable()
export class GetSignatureCaptureSessionStatusUseCase {
  constructor(
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

    return this.sessions.toStatusResponse(
      session,
      user.signingCredentialStatus,
    );
  }
}
