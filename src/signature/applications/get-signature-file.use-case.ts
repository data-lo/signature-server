import { Injectable } from '@nestjs/common';

import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';

import { SignatureService } from '../signature.service';

/**
 * `GET /signature/files/:fileId`: URL prefirmada y temporal de un archivo de firma.
 *
 * Lo que se entrega es un enlace con caducidad, no el archivo: así el bucket puede seguir siendo
 * privado y el cliente pinta la imagen directamente desde MinIO, sin que el servidor tenga que
 * hacer de intermediario en cada carga.
 */
@Injectable()
export class GetSignatureFileUseCase {
  constructor(private readonly signatureService: SignatureService) {}

  async execute(objectKey: string, bucketType: BUCKET_TYPES_ENUM) {
    return this.signatureService.getFile(objectKey, bucketType);
  }
}
