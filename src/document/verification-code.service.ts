import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
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

  /**
   * `manager` opcional: cuando se emite dentro de una transacción más grande (ver
   * CreateDocumentSignatureFlowUseCase), pasar el `EntityManager` transaccional para que el INSERT
   * corra en la misma transacción y participe del rollback si algo más falla después. Sin
   * `manager`, usa el repositorio inyectado normal (comportamiento previo, sin cambios).
   */
  async issue(
    documentId: string,
    signerId: string | null,
    event: VERIFICATION_EVENT_ENUM,
    ipAddress: string,
    manager?: EntityManager,
  ): Promise<VerificationCodeEntity> {
    const repository = manager
      ? manager.getRepository(VerificationCodeEntity)
      : this.verificationCodeRepository;

    const code = this.otpService.generate();
    const expiredAt = new Date(Date.now() + CODE_VALIDITY_MINUTES * 60 * 1000);

    const entity = repository.create({
      documentId,
      signerId,
      event,
      code,
      ipAddress,
      expiredAt,
      isUsed: false,
    });

    return repository.save(entity);
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

  /**
   * Código que ese firmante efectivamente consumió, o `null` si no consumió ninguno.
   *
   * Lo usa la vista pública de verificación para el renglón "OTP Code" de cada firma simple (ver
   * historia "Actualizar vista pública de verificación de documentos según estado y tipo de
   * firma"): es la evidencia de con qué código se acreditó su identidad, el mismo dato que la
   * plantilla de la hoja de firmas contempla.
   *
   * Se toma el MÁS RECIENTE (`usedAt` descendente): un firmante puede haber pedido varios códigos
   * —y consumido más de uno si un intento anterior no completó la firma—, y el que sustenta la
   * firma registrada es el último.
   */
  async findConsumedCode(
    documentId: string,
    signerId: string,
    event: VERIFICATION_EVENT_ENUM,
  ): Promise<string | null> {
    const record = await this.verificationCodeRepository.findOne({
      where: { documentId, signerId, event, isUsed: true },
      order: { usedAt: 'DESC' },
    });
    return record?.code ?? null;
  }
}
