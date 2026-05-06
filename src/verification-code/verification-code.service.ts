// 1. NestJS (framework)
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
// 2. Third-party libraries
import { Repository } from 'typeorm';
// 3. Internal modules
import { VerificationCodeEntity } from './entities/verification-code.entity';

import { ValidateCodeDto } from './dto/validate-code.dto';
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';

import { UserService } from 'src/user/user.service';
import { OTPService } from 'src/shared/otp/otp.service';
import { RedisService } from 'src/shared/redis/redis.service';
import { DocumentService } from 'src/document/document.service';
import { VerificationCodeObject } from './interfaces/verification-code-object';
import { CodeType } from './enums/code-type.enum';

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
   * @returns Mensaje de confirmación
   * @throws ForbiddenException - Si el firmante no está asociado al documento
   */
  async create(dto: CreateVerificationCodeDto): Promise<{}> {
    const document = await this.documentService.findOne(dto.documentId);

    if (dto.signerId !== document.signerId) {
      throw new ForbiddenException('El firmante no está asociado a este documento');
    }

    const user = await this.userService.findOne(dto.signerId);

    const code = await this.otpService.generate();

    const expiredAt = new Date();

    expiredAt.setSeconds(expiredAt.getSeconds() + this.OTP_TTL);

    const verificationCodeObject = {
      code,
      expiredAt,
      type: dto.type,
      signerId: dto.signerId,
      documentId: dto.documentId,
    }

    await this.redisService.set(`${dto.documentId}`, JSON.stringify(verificationCodeObject), this.OTP_TTL);

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

  /**
   * Verifica el código OTP enviado por el firmante y registra su uso.
   *
   * - Valida que el código OTP coincida con el registrado en Redis
   * - Verifica que el firmante esté asociado al documento
   * - Elimina el OTP de Redis garantizando uso único
   * - Persiste y marca el registro como usado en base de datos
   *
   * @param dto - Datos de validación: código OTP, firmante y documento
   * @param ipAddress - Dirección IP desde donde se realiza la validación
   * @returns Mensaje de confirmación del procesamiento del documento
   * @throws NotFoundException - Si el código OTP no existe o ha expirado
   * @throws ForbiddenException - Si el firmante no está asociado al documento
   * @throws UnauthorizedException - Si el código OTP es inválido
   */
  async validateAndSaveCode(
    dto: ValidateCodeDto,
    ipAddress: string,
  ): Promise<{ message: string }> {

    let verificationCodeString = await this.redisService.get(`${dto.documentId}`);

    if (!verificationCodeString) {
      throw new NotFoundException('Código de verificación no encontrado o expirado');
    }

    const verificationCode = JSON.parse(verificationCodeString) as VerificationCodeObject;

    if (dto.signerId !== verificationCode.signerId) {
      throw new ForbiddenException('El firmante no está asociado a este documento');
    }

    const isValid = this.otpService.verify(dto.code, verificationCode.code);

    if (!isValid) {
      throw new UnauthorizedException('Código de verificación inválido');
    }

    await this.redisService.del(`${this.KEY_PREFIX}${dto.documentId}`);

    await this.verificationCodeRepository.update(
      { documentId: dto.documentId },
      {
        ipAddress,
        isUsed: true,
        usedAt: new Date(),
        code: verificationCode.code,
        signerId: verificationCode.signerId,
        documentId: verificationCode.documentId,
        type: CodeType.VERIFICATION
      },
    );

    this.eventEmitter.emit('document.sign', {
      signerId: dto.signerId,
      documentId: dto.documentId
    });

    return {
      message: 'Documento enviado a procesamiento, la firma será estampada en breve',
    };
  }
}