import { BadRequestException, Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

import { SignatureService } from '../signature.service';

/**
 * `DELETE /signature/:id/official-file`: borra la identificación oficial.
 *
 * Si con esto la fila queda sin ningún archivo, se elimina entera y se suelta la referencia
 * desde el usuario: una firma sin imagen ni identificación no es un registro a medias que se
 * pueda completar, es un registro que estorba —`create` rechazaría uno nuevo porque "ya tienes
 * una firma registrada"—. Esa decisión se toma bajo un lock sobre la fila (ver
 * `clearFieldOrDeleteRow`), porque el borrado del otro archivo puede estar ocurriendo a la vez.
 */
@Injectable()
export class DeleteOfficialFileUseCase {
  constructor(private readonly signatureService: SignatureService) {}

  async execute(
    id: string,
    currentUserId: string,
  ): Promise<BaseResponse<null>> {
    const signature = await this.signatureService.findOne(id);

    await this.signatureService.assertOwnership(id, currentUserId);

    if (!signature.officialCardObjectKey) {
      throw new BadRequestException(
        'No hay una identificación oficial registrada para eliminar',
      );
    }

    await this.signatureService.deleteFileIfExists(
      signature.officialCardObjectKey,
      BUCKET_TYPES_ENUM.OFICIAL_CARDS,
      'Error al eliminar la identificación oficial en el almacenamiento',
    );

    await this.signatureService.clearFieldOrDeleteRow(
      id,
      currentUserId,
      'officialCardObjectKey',
    );

    return {
      success: true,
      message: 'Identificación oficial eliminada correctamente',
      data: null,
    };
  }
}
