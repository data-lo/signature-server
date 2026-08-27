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
   * Constancia pública de una firma avanzada — el destino del código QR estampado en el documento
   * (historia "Generar código QR para firmas avanzadas").
   *
   * Sin autenticación, igual que `getPublicDocumentView`: quien tiene el documento en la mano
   * puede escanear el QR y verificar quién firmó y cuándo sin necesidad de tener cuenta. Por eso
   * el gate es estricto — solo responde para una firma avanzada YA COMPLETADA de ese documento:
   *
   *  - si el colaborador no pertenece al documento, no existe o no es firmante → 404
   *  - si su firma es simple → 404 (su constancia es la rúbrica visible, no este QR)
   *  - si todavía no firmó → 404, no hay firma que consultar
   *
   * Se responde 404 y no 403 a propósito: un 403 confirmaría que ese colaborador existe, y esta
   * ruta la puede llamar cualquiera con un UUID.
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
