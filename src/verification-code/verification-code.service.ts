import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VerificationCodeEntity } from './entities/verification-code.entity';
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { VerifyVerificationCodeDto } from './dto/verify-verification-code.dto';
import { OtpService } from '../shared/otp/otp.service';

@Injectable()
export class VerificationCodeService {
  constructor(
    @InjectRepository(VerificationCodeEntity)
    private readonly verificationCodeRepository: Repository<VerificationCodeEntity>,
    private readonly otpService: OtpService,
  ) {}

  /**
   * Genera un nuevo código OTP para el firmante y lo almacena en Redis con TTL de 15 minutos.
   * Registra el evento en la base de datos como auditoría (código, tipo, expiración, firmante, documento).
   * Retorna el código de 6 dígitos que debe enviarse al usuario por correo.
   */
  async create(dto: CreateVerificationCodeDto): Promise<string> {
    const code = await this.otpService.generateAndStore(dto.signerId);

    // Guardar en redis

    const expiredAt = new Date();
    expiredAt.setSeconds(expiredAt.getSeconds() + 900);

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

  /**
   * Verifica el token OTP ingresado por el firmante consultando el secreto en Redis.
   * Si es válido, marca el registro en base de datos como usado, registrando fecha y dirección IP.
   * Retorna true si el token es correcto, false si expiró o no coincide.
   */
  async verifyCode(
    dto: VerifyVerificationCodeDto,
    ipAddress?: string,
  ): Promise<boolean> {
    const isValid = await this.otpService.verify(dto.signerId, dto.token);

    if (isValid) {
      await this.verificationCodeRepository.update(
        { signerId: dto.signerId, isUsed: false },
        { isUsed: true, usedAt: new Date(), ipAddress },
      );
    }

    return isValid;
  }

  /**
   * Retorna el historial de códigos OTP generados para un firmante específico,
   * ordenados del más reciente al más antiguo.
   */
  async findBySigner(signerId: string): Promise<VerificationCodeEntity[]> {
    return this.verificationCodeRepository.find({
      where: { signerId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Retorna el historial de códigos OTP asociados a un documento específico,
   * ordenados del más reciente al más antiguo.
   */
  async findByDocument(documentId: string): Promise<VerificationCodeEntity[]> {
    return this.verificationCodeRepository.find({
      where: { documentId },
      order: { createdAt: 'DESC' },
    });
  }
}
