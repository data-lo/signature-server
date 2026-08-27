import { BadRequestException, Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

import { SignatureService } from '../signature.service';

/**
 * `PATCH /signature/:id/deactivate`: deja de usar una firma sin borrarla.
 *
 * La fila y el object key se conservan, y lo que cambia es el contenido del PNG: pasa a ser una
 * imagen transparente. Borrar el objeto rompería los documentos ya firmados que apuntan a él,
 * mientras que vaciarlo deja de mostrar el trazo sin tocar el pasado.
 *
 * Desactivar una firma ya desactivada es un 400 y no un no-op silencioso: quien lo pide cree
 * que está haciendo algo, y responder éxito le haría pensar que había una firma activa.
 */
@Injectable()
export class DeactivateSignatureUseCase {
  constructor(private readonly signatureService: SignatureService) {}

  async execute(id: string, currentUserId: string): Promise<BaseResponse> {
    const signature = await this.signatureService.findOne(id);

    await this.signatureService.assertOwnership(id, currentUserId);

    if (!signature.isActive) {
      throw new BadRequestException(
        `La firma con ID ${id} ya está desactivada`,
      );
    }

    await this.signatureService.blankOutSignatureImage(
      signature.signatureObjectKey,
    );

    await this.signatureService.setActive(id, false);

    /**
     * La URL prefirmada se devuelve ya apuntando al PNG vacío: el cliente acaba de mostrar la
     * firma anterior y necesita algo con qué reemplazarla en pantalla sin volver a pedirla.
     */
    const minio = await this.signatureService.getFile(
      signature.signatureObjectKey,
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );

    return {
      success: true,
      message: 'Firma desactivada correctamente',
      data: {
        id: signature.id,
        secureUrl: minio.secureUrl,
        expiresIn: minio.expiresIn,
      },
    };
  }
}
