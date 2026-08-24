import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SigningCredentialNotReadyException } from 'src/identity-verification/exceptions/identity-verification.exceptions';
import { UpdateSigningCredentialStatusUseCase } from 'src/identity-verification/applications/update-signing-credential-status.use-case';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { CreateSignatureDto } from '../dto/create-signature.dto';
import { SignatureService } from '../signature.service';

/**
 * Por qué el usuario todavía no puede registrar su firma, según su estado global.
 *
 * Se explica el motivo en vez de devolver un 403 seco: un "no puedes subir tu firma" sin decir
 * que la verificación sigue en revisión deja al usuario sin saber qué hacer a continuación.
 */
const BLOCKED_REASON_BY_STATUS: Record<SIGNING_CREDENTIAL_STATUS_ENUM, string> =
  {
    [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED]:
      'Necesitas validar tu identidad antes de registrar tu firma.',
    [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_PENDING]:
      'Tu verificación de identidad aún no ha comenzado. Complétala antes de registrar tu firma.',
    [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_PROGRESS]:
      'Tu verificación de identidad está en curso. Termínala antes de registrar tu firma.',
    [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_IN_REVIEW]:
      'Tu identidad está en revisión. Te avisaremos en cuanto tengamos el resultado.',
    [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_RETRY_REQUIRED]:
      'No fue posible validar tu identidad. Inicia una nueva verificación para registrar tu firma.',
    [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_FAILED]:
      'Tu verificación de identidad está bloqueada. Contacta a soporte para continuar.',
    [SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED]:
      'Agotaste tus intentos de verificación de identidad. Contacta a soporte para desbloquear tu cuenta.',
    [SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING]: '',
    [SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED]:
      'Ya tienes una firma registrada. Elimínala antes de subir una nueva.',
  };

/**
 * `PUT /api/v1/users/me/signature`: registra la firma PNG del usuario.
 *
 * Acá vive la regla —sólo se acepta la firma en SIGNATURE_PENDING— y el cambio de estado a
 * CONFIGURED. El trabajo técnico (validar tamaños, subir a MinIO, persistir la fila y enlazarla
 * al usuario) sigue en `SignatureService`, que no decide nada sobre el avance del usuario.
 *
 * La comprobación va contra `users.signing_credential_status` y no contra la tabla de
 * verificaciones: es la variable global del flujo, y consultarla acá es lo que garantiza que
 * todos los módulos bloqueen por el mismo criterio.
 */
@Injectable()
export class UploadSignatureImageUseCase {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly signatureService: SignatureService,
    private readonly updateSigningCredentialStatus: UpdateSigningCredentialStatusUseCase,
  ) {}

  async execute(
    userId: string,
    dto: CreateSignatureDto,
    files: {
      signatureImage?: Express.Multer.File[];
      officialFile?: Express.Multer.File[];
    },
  ): Promise<BaseResponse<{ id: string }>> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`Usuario con id ${userId} no encontrado`);
    }

    /**
     * La regla se aplica en el caso de uso, no en el controller ni en el frontend: es el único
     * punto por el que pasan todas las altas, así que es el único lugar donde no se puede
     * rodear.
     */
    if (
      user.signingCredentialStatus !==
      SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING
    ) {
      throw new SigningCredentialNotReadyException(
        BLOCKED_REASON_BY_STATUS[user.signingCredentialStatus],
      );
    }

    const result = await this.signatureService.create(userId, dto, files);

    // Segunda mitad de la credencial: con identidad aprobada y firma PNG registrada, queda lista.
    await this.updateSigningCredentialStatus.execute(
      userId,
      SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
    );

    return result;
  }
}
