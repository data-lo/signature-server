import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PasswordResetCodeEntity } from './entities/password-reset-code.entity';
import { OTPService } from 'src/shared/otp/otp.service';

const PASSWORD_RESET_CODE_VALIDITY_MINUTES = 15;

/**
 * Respalda con persistencia real al OTPService genérico (ver
 * src/document/verification-code.service.ts, el mismo patrón para firma de
 * documentos) para el flujo de recuperación de contraseña. La expiración
 * (`expiredAt`) y el consumo de un solo uso (`isUsed`) los gobierna esta clase.
 */
@Injectable()
export class PasswordResetCodeService {
  constructor(
    @InjectRepository(PasswordResetCodeEntity)
    private readonly passwordResetCodeRepository: Repository<PasswordResetCodeEntity>,
    private readonly otpService: OTPService,
  ) {}

  async issue(userId: string): Promise<PasswordResetCodeEntity> {
    const code = this.otpService.generate();
    const expiredAt = new Date(
      Date.now() + PASSWORD_RESET_CODE_VALIDITY_MINUTES * 60 * 1000,
    );

    const entity = this.passwordResetCodeRepository.create({
      userId,
      code,
      expiredAt,
      isUsed: false,
    });

    return this.passwordResetCodeRepository.save(entity);
  }

  /**
   * Verifica el código contra el último emitido para ese usuario sin usar, y lo
   * marca consumido de un solo uso. Mensajes distintos para "no hay código
   * pendiente", "expiró" y "no coincide".
   */
  async verifyAndConsume(userId: string, submittedCode: string): Promise<void> {
    const record = await this.passwordResetCodeRepository.findOne({
      where: { userId, isUsed: false },
      order: { createdAt: 'DESC' },
    });

    if (!record) {
      throw new BadRequestException(
        'No hay un código de recuperación pendiente para este usuario',
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
    await this.passwordResetCodeRepository.save(record);
  }
}
