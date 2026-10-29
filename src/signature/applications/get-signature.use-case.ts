import { Injectable } from '@nestjs/common';

import { SignatureEntity } from '../entities/signature.entity';
import { SignatureService } from '../signature.service';

/**
 * `GET /signature/:id`: los metadatos de una firma.
 *
 * Devuelve la fila, no los archivos: quien necesite verlos pide después una URL prefirmada con
 * `GET /signature/files/:fileId`.
 */
@Injectable()
export class GetSignatureUseCase {
  constructor(private readonly signatureService: SignatureService) {}

  async execute(id: string): Promise<SignatureEntity> {
    return this.signatureService.findOne(id);
  }
}
