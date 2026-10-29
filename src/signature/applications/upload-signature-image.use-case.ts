import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { SigningCredentialNotReadyException } from 'src/identity-verification/exceptions/identity-verification.exceptions';
import { UpdateSigningCredentialStatusUseCase } from 'src/identity-verification/applications/update-signing-credential-status.use-case';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { CreateSignatureDto } from '../dto/create-signature.dto';
import { SIGNING_CREDENTIAL_BLOCK_REASON } from '../constants/signing-credential-block-reason';
import { SignatureService } from '../signature.service';

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
        SIGNING_CREDENTIAL_BLOCK_REASON[user.signingCredentialStatus],
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
