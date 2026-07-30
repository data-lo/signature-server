import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { EmailVerificationCodeEntity } from './entities/email-verification-code.entity';
import { OTPService } from 'src/shared/otp/otp.service';

const EMAIL_OTP_VALIDITY_MINUTES = 15;

/**
 * Respalda con persistencia real al OTPService genérico (ver
 * src/document/verification-code.service.ts, el mismo patrón para firma de documentos) para el
 * flujo de verificación de correo de registro. La expiración (`expiredAt`) y el consumo de un
 * solo uso (`isUsed`) los gobierna esta clase.
 */
@Injectable()
export class EmailVerificationCodeService {
  constructor(
    @InjectRepository(EmailVerificationCodeEntity)
    private readonly emailVerificationCodeRepository: Repository<EmailVerificationCodeEntity>,
    private readonly otpService: OTPService,
  ) {}

  /**
   * `manager` opcional: permite emitir el primer código dentro de la misma transacción que crea
   * la pre-cuenta (ver UserService.createFromSignup), igual que VerificationCodeService.issue.
   */
  async issue(
    userId: string,
    manager?: EntityManager,
  ): Promise<EmailVerificationCodeEntity> {
    const repository = manager
      ? manager.getRepository(EmailVerificationCodeEntity)
      : this.emailVerificationCodeRepository;

    const code = this.otpService.generate();
    const expiredAt = new Date(
      Date.now() + EMAIL_OTP_VALIDITY_MINUTES * 60 * 1000,
    );

    const entity = repository.create({
      userId,
      code,
      expiredAt,
      isUsed: false,
    });

    return repository.save(entity);
  }

  /**
   * Verifica el código contra el último emitido para ese usuario sin usar, y lo marca consumido
   * de un solo uso. Mensajes distintos para "no hay código pendiente", "expiró" y "no coincide".
   */
  async verifyAndConsume(userId: string, submittedCode: string): Promise<void> {
    const record = await this.emailVerificationCodeRepository.findOne({
      where: { userId, isUsed: false },
      order: { createdAt: 'DESC' },
    });

    if (!record) {
      throw new BadRequestException(
        'No hay un código de verificación pendiente para este usuario',
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
    await this.emailVerificationCodeRepository.save(record);
  }
}
