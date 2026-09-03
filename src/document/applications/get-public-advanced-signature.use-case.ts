import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BaseResponse } from 'src/interfaces/api-response.dto';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import { AdvancedSignaturePublicViewData } from '../interfaces/responses/advanced-signature-public-view-response';
import { collaboratorDisplayName } from '../utils/collaborator-display.util';
import { DocumentService } from '../document.service';

@Injectable()
export class GetPublicAdvancedSignatureUseCase {
  constructor(
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * Devuelve la constancia pública de una firma avanzada: el destino del QR estampado en el
   * documento.
   *
   * Va sin autenticación, igual que la vista pública: quien tiene el documento en la mano puede
   * escanear el QR y verificar quién firmó y cuándo sin tener cuenta. Por eso el gate es estricto y
   * sólo responde para una firma avanzada YA COMPLETADA de ese documento:
   *
   *  - colaborador ajeno al documento, inexistente o que no es firmante → 404
   *  - firma simple → 404, porque su constancia es la rúbrica visible y no este QR
   *  - firma todavía pendiente → 404, no hay firma que consultar
   *
   * Responde 404 y no 403 a propósito: un 403 confirmaría que ese colaborador existe, y esta ruta la
   * puede llamar cualquiera con un UUID.
   */
  async execute(
    documentId: string,
    collaboratorId: string,
  ): Promise<BaseResponse<AdvancedSignaturePublicViewData>> {
    const collaborator = await this.collaboratorRepository.findOne({
      where: {
        id: collaboratorId,
        documentId,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
      relations: { account: { user: true } },
    });

    if (
      !collaborator ||
      collaborator.signatureType !== SIGNATURE_TYPE_ENUM.FIEL ||
      collaborator.status !== SIGNEE_STATUS_ENUM.SIGNED ||
      !collaborator.signedAt
    ) {
      throw new NotFoundException('Firma avanzada no encontrada');
    }

    const document = await this.documentService.findOne(documentId);
    const certificate = collaborator.advancedSignature?.certificate;

    return {
      success: true,
      message: 'Firma obtenida correctamente',
      data: {
        documentId: document.id,
        fileName: document.fileName,
        // El nombre del certificado es el que el SAT tiene registrado para ese RFC, así que es el
        // más fiel a quién firmó; el del perfil es el respaldo cuando no hay evidencia guardada.
        signerName: certificate?.name ?? collaboratorDisplayName(collaborator),
        rfc: certificate?.rfc ?? null,
        certificateSerialNumber: certificate?.serialNumber ?? null,
        signedAt: collaborator.signedAt.toISOString(),
      },
    };
  }
}
