import { Injectable } from '@nestjs/common';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { UpdateSigningCredentialStatusUseCase } from 'src/identity-verification/applications/update-signing-credential-status.use-case';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { SignatureService } from '../signature.service';

/**
 * `DELETE /signature/:id/signature-image`: elimina la firma PNG del usuario.
 *
 * La identidad sigue aprobada —eso no se pierde por borrar un archivo—, así que el usuario
 * vuelve a SIGNATURE_PENDING y puede subir otra firma sin repetir la verificación.
 *
 * El borrado en MinIO y en base de datos (incluida la carrera con el borrado de la INE) sigue
 * en `SignatureService`; acá está sólo qué significa ese borrado para el avance del usuario.
 */
@Injectable()
export class DeleteSignatureImageUseCase {
  constructor(
    private readonly signatureService: SignatureService,
    private readonly updateSigningCredentialStatus: UpdateSigningCredentialStatusUseCase,
  ) {}

  async execute(
    signatureId: string,
    currentUserId: string,
  ): Promise<BaseResponse<null>> {
    const result = await this.signatureService.deleteSignatureImage(
      signatureId,
      currentUserId,
    );

    /**
     * `applyIfAllowed`: el archivo ya no existe. Si el usuario estaba en un estado desde el que
     * SIGNATURE_PENDING no es alcanzable (un bloqueo administrativo, por ejemplo), se registra
     * y se sigue — fallar acá no devolvería la firma borrada.
     */
    await this.updateSigningCredentialStatus.applyIfAllowed(
      currentUserId,
      SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
    );

    return result;
  }
}
