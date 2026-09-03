import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import {
  MAX_IMAGE_FILE_SIZE_BYTES,
  MAX_PDF_FILE_SIZE_BYTES,
} from 'src/shared/constants/file-upload.constants';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';

import { SignatureService } from '../signature.service';
import { UpdateSigningCredentialStatusUseCase } from 'src/identity-verification/applications/update-signing-credential-status.use-case';

/**
 * Reemplaza la imagen de la firma, la identificación oficial, o ambas (`PATCH /signature/:id`).
 *
 * Los dos archivos son opcionales e independientes: sólo se toca lo que venga en la petición, porque
 * esta pantalla permite corregir uno sin volver a subir el otro.
 *
 * Una firma desactivada vuelve a activarse al actualizarla —y el mensaje lo dice—: subir un archivo
 * nuevo es justamente la señal de que el usuario quiere volver a usarla, y dejarla inactiva
 * obligaría a un paso extra que nadie esperaría.
 */
@Injectable()
export class UpdateSignatureUseCase {
  constructor(
    private readonly signatureService: SignatureService,
    private readonly updateSigningCredentialStatus: UpdateSigningCredentialStatusUseCase,
  ) {}

  async execute(
    id: string,
    currentUserId: string,
    files: {
      signatureImage?: Express.Multer.File;
      officialFile?: Express.Multer.File;
    },
  ): Promise<BaseResponse<{ id: string }>> {
    const signature = await this.signatureService.findOne(id);

    await this.signatureService.assertOwnership(id, currentUserId);

    /**
     * Los tamaños se comprueban antes de subir nada: con dos archivos en la misma petición,
     * validar sobre la marcha dejaría el primero ya escrito en MinIO cuando el segundo se
     * rechaza.
     */
    if (files.signatureImage) {
      this.signatureService.assertWithinSizeLimit(
        files.signatureImage,
        MAX_IMAGE_FILE_SIZE_BYTES,
        'La imagen de firma',
      );
    }
    if (files.officialFile) {
      this.signatureService.assertWithinSizeLimit(
        files.officialFile,
        MAX_PDF_FILE_SIZE_BYTES,
        'La identificación oficial',
      );
    }

    let message = 'Firma actualizada correctamente';

    if (!signature.isActive) {
      await this.signatureService.setActive(id, true);
      message = 'Firma activa y actualizada correctamente';
    }

    if (files.signatureImage) {
      await this.signatureService.replaceOrUploadFile(
        id,
        signature.signatureObjectKey,
        files.signatureImage,
        BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
        'signatureObjectKey',
      );
    }

    if (files.officialFile) {
      await this.signatureService.replaceOrUploadFile(
        id,
        signature.officialCardObjectKey,
        files.officialFile,
        BUCKET_TYPES_ENUM.OFICIAL_CARDS,
        'officialCardObjectKey',
      );
    }

    if (files.signatureImage) {
      /**
       * Reponer la firma PNG por esta vía también completa la credencial: el usuario que la
       * borró quedó en SIGNATURE_PENDING y sin esto seguiría ahí pese a tener firma otra vez.
       * `applyIfAllowed` mantiene el resto de los casos como no-op (ya CONFIGURED, o identidad
       * no aprobada).
       */
      await this.updateSigningCredentialStatus.applyIfAllowed(
        currentUserId,
        SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
      );
    }

    return {
      success: true,
      message,
      data: { id: signature.id },
    };
  }
}
