// 1. NestJS (framework)
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, Injectable } from '@nestjs/common';
// 2. Third-party libraries
import { Repository } from 'typeorm';
// 3. Internal modules
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { VerifyVerificationCodeDto } from './dto/verify-verification-code.dto';

import { UserService } from 'src/user/user.service';
import { OTPService } from 'src/shared/otp/otp.service';
import { RedisService } from 'src/shared/redis/redis.service';
import { DocumentService } from 'src/document/document.service';

@Injectable()
export class VerificationCodeService {
  private readonly OTP_TTL = 900;
  private readonly KEY_PREFIX = 'OTP:';

  constructor(
    @InjectRepository(VerificationCodeEntity)
    private readonly verificationCodeRepository: Repository<VerificationCodeEntity>,
    private readonly eventEmitter: EventEmitter2,
    private readonly otpService: OTPService,
    private readonly userService: UserService,
    private readonly redisService: RedisService,
    private readonly documentService: DocumentService,
  ) { }

  /**
   * Genera y envía un código OTP al firmante del documento.
   *
   * - Valida que el firmante esté asociado al documento
   * - Almacena el código en Redis con un TTL de 15 minutos
   * - Emite un evento para enviar el código por correo
   *
   * @param dto - Datos del firmante y documento
   * @returns Mensaje de confirmación y código generado
   * @throws ForbiddenException - Si el firmante no está asociado al documento
   */
  async create(dto: CreateVerificationCodeDto) {
    const document = await this.documentService.findOne(dto.documentId);

    if (dto.signerId !== document.signerId) {
      throw new ForbiddenException('El firmante no está asociado a este documento');
    }

    const user = await this.userService.findOne(dto.signerId);

    const code = await this.otpService.generate();

    const expiredAt = new Date();

    expiredAt.setSeconds(expiredAt.getSeconds() + this.OTP_TTL);

    await this.verificationCodeRepository.save({
      code,
      type: dto.type ?? 'document_signing',
      isUsed: false,
      expiredAt,
      signerId: dto.signerId,
      documentId: dto.documentId,
    });

    await this.redisService.set(`${this.KEY_PREFIX}${dto.documentId}`, code, this.OTP_TTL);

    this.eventEmitter.emit('send.verification.code.email', {
      to: user.email,
      documentName: document.fileName,
      signerName: `${user.firstName} ${user.lastName}`,
      code,
    });

    return {
      message: 'Código enviado al correo del firmante',
    }
  }

  // Verifica que el token enviado por el firmante coincida con el OTP activo en Redis.
  // Si es válido, elimina el OTP de Redis (uso único) y marca el registro en BD como usado.
  async verifyCode(
    dto: VerifyVerificationCodeDto,
    ipAddress?: string,
  ): Promise<boolean> {
    const storedCode = await this.redisService.get(`${this.KEY_PREFIX}${dto.signerId}`);
    if (!storedCode) return false;

    const isValid = this.otpService.verify(dto.token, storedCode);

    if (isValid) {
      await this.redisService.del(`${this.KEY_PREFIX}${dto.signerId}`);
      await this.verificationCodeRepository.update(
        { signerId: dto.signerId, isUsed: false },
        { isUsed: true, usedAt: new Date(), ipAddress },
      );
    }

    return isValid;
  }

  // Invalida manualmente el OTP activo de un firmante eliminándolo de Redis.
  async revoke(signerId: string): Promise<void> {
    await this.redisService.del(`${this.KEY_PREFIX}${signerId}`);
  }

  // Indica si el firmante tiene un OTP vigente en Redis (no expirado ni revocado).
  async hasActive(signerId: string): Promise<boolean> {
    return (await this.redisService.exists(`${this.KEY_PREFIX}${signerId}`)) > 0;
  }

  // Retorna todos los registros de códigos de verificación asociados a un firmante, del más reciente al más antiguo.
  async findBySigner(signerId: string): Promise<VerificationCodeEntity[]> {
    return this.verificationCodeRepository.find({
      where: { signerId },
      order: { createdAt: 'DESC' },
    });
  }

  // Retorna todos los registros de códigos de verificación asociados a un documento, del más reciente al más antiguo.
  async findByDocument(documentId: string): Promise<VerificationCodeEntity[]> {
    return this.verificationCodeRepository.find({
      where: { documentId },
      order: { createdAt: 'DESC' },
    });
  }
}
