import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { VERIFICATION_EVENT_ENUM } from './enum/verification-event.enum';
import { OTPService } from 'src/shared/otp/otp.service';

const CODE_VALIDITY_MINUTES = 15;

/**
 * Respalda con persistencia real al OTPService ya existente (ver plan de migración ER-V2,
 * Fase 7). La expiración (`expiredAt`) y el consumo de un solo uso (`isUsed`) los gobierna
 * esta clase — OTPService en sí mismo no persiste nada ni valida vigencia.
 */
@Injectable()
export class VerificationCodeService {
  constructor(
    @InjectRepository(VerificationCodeEntity)
    private readonly verificationCodeRepository: Repository<VerificationCodeEntity>,
    private readonly otpService: OTPService,
  ) {}

  async issue(
    documentId: string,
    signerId: string | null,
    event: VERIFICATION_EVENT_ENUM,
    ipAddress: string,
  ): Promise<VerificationCodeEntity> {
    const code = this.otpService.generate();
    const expiredAt = new Date(Date.now() + CODE_VALIDITY_MINUTES * 60 * 1000);

    const entity = this.verificationCodeRepository.create({
      documentId,
      signerId,
      event,
      code,
      ipAddress,
      expiredAt,
      isUsed: false,
    });

    return this.verificationCodeRepository.save(entity);
  }

  /**
   * Verifica el código contra el último emitido para (documentId, signerId) sin usar, y lo
   * marca consumido de un solo uso. Lanza BadRequestException con mensajes distintos para
   * "no hay código pendiente", "expiró" y "no coincide", útil para la UI.
   */
  async verifyAndConsume(
    documentId: string,
    signerId: string | null,
    submittedCode: string,
  ): Promise<void> {
    const record = await this.verificationCodeRepository.findOne({
      where: {
        documentId,
        signerId: signerId ?? IsNull(),
        isUsed: false,
      },
      order: { createdAt: 'DESC' },
    });

    if (!record) {
      throw new BadRequestException(
        'No hay un código de verificación pendiente para este documento',
      );
    }

    if (record.expiredAt.getTime() < Date.now()) {
      throw new BadRequestException('El código de verificación expiró');
    }

    if (!this.otpService.verify(submittedCode, record.code)) {
      throw new BadRequestException('Código de verificación inválido');
    }

    record.isUsed = true;
    record.usedAt = new Date();
    await this.verificationCodeRepository.save(record);
  }

  /** Usado por DocumentService.sign() para exigir verificación cuando document.requiresVerification=true. */
  async hasConsumedCode(
    documentId: string,
    signerId: string,
    event: VERIFICATION_EVENT_ENUM,
  ): Promise<boolean> {
    const record = await this.verificationCodeRepository.findOne({
      where: { documentId, signerId, event, isUsed: true },
    });
    return Boolean(record);
  }
}
