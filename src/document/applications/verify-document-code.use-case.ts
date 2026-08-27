import { Injectable } from '@nestjs/common';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { VerificationCodeService } from '../verification-code.service';
import { DocumentService } from '../document.service';

/**
 * `POST /document/:id/verification-codes/verify`: canjea el código de 2FA antes de firmar.
 *
 * El código se consume acá y no al firmar: la pantalla lo pide en un paso propio, y dejar el
 * canje para el momento de la firma haría que un código equivocado se descubriera recién
 * después de que el firmante cargara su e.firma.
 */
@Injectable()
export class VerifyDocumentCodeUseCase {
  constructor(
    private readonly verificationCodeService: VerificationCodeService,
    private readonly documentService: DocumentService,
  ) {}

  async execute(
    documentId: string,
    currentUserId: string,
    code: string,
  ): Promise<BaseResponse<null>> {
    const myParticipant = await this.documentService.findMySignerCollaborator(
      documentId,
      currentUserId,
    );

    await this.verificationCodeService.verifyAndConsume(
      documentId,
      myParticipant.id,
      code,
    );

    return {
      success: true,
      message: 'Código verificado correctamente',
      data: null,
    };
  }
}
