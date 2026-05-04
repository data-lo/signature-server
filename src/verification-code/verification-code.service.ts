import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { VerifyVerificationCodeDto } from './dto/verify-verification-code.dto';
import { OtpService } from '../shared/otp/otp.service';
import { RedisService } from '../shared/redis/redis.service';

@Injectable()
export class VerificationCodeService {
  // TTL de 15 minutos para los OTPs en Redis
  private readonly OTP_TTL = 900;
  private readonly KEY_PREFIX = 'otp:';

  constructor(
    @InjectRepository(VerificationCodeEntity)
    private readonly verificationCodeRepository: Repository<VerificationCodeEntity>,
    private readonly otpService: OtpService,
    private readonly redisService: RedisService,
  ) {}

  // Genera un nuevo OTP, lo almacena en Redis con TTL y persiste el registro en BD.
  // Retorna el código generado para que el llamador lo envíe al firmante.
  async create(dto: CreateVerificationCodeDto): Promise<string> {
    const code = await this.otpService.generate();
    await this.redisService.set(`${this.KEY_PREFIX}${dto.signerId}`, code, this.OTP_TTL);

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

    return code;
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
