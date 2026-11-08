import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { AUDIT_AUTH_MECHANISM_ENUM } from 'src/audit/schema/audit-document';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { isPublicSigningAllowed } from 'src/signing-invitation/public-signing-eligibility';
import { SigningInvitationDeliveryService } from 'src/signing-invitation/signing-invitation-delivery.service';

import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { DocumentEntity } from '../../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { collaboratorEmail } from '../../utils/collaborator-display.util';
import { isSignerTurn } from '../../utils/next-signer.util';
import {
  IntegrationInvitationNotResendableException,
  IntegrationSignerNotFoundException,
} from '../exceptions/integration-document.exceptions';
import { findSignerByEmail } from '../utils/find-signer-by-email.util';

/** Resultado del reenvío. Nunca incluye el enlace (sólo llega al correo del firmante) ni ids internos. */
export interface ResentSigningInvitation {
  email: string;
  invitationExpiresAt: Date;
  emailDelivered: boolean;
}

/**
 * `POST /integration/documents/:documentId/collaborators/resend-invitation`: emite una invitación
 * nueva (`/sign/:token`) para el firmante con ese correo y se la envía. La anterior deja de servir.
 * El id del colaborador se resuelve aquí y sólo se usa internamente.
 *
 * El documento tiene que ser de la organización de la API key —la organización sale de la llave,
 * nunca del request— y el firmante tiene que poder firmar ya: documento esperando firmas, firmante
 * pendiente, en su turno y con firma pública admitida. Los límites de reenvío por firmante y la
 * auditoría (con el `apiKeyId`) los aplica `SigningInvitationDeliveryService`.
 */
@Injectable()
export class ResendIntegrationSigningInvitationUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly delivery: SigningInvitationDeliveryService,
  ) {}

  /**
   * Reenvía la invitación de un firmante.
   *
   * @param apiClient - Cliente autenticado por la API key.
   * @param documentId - Documento de la ruta.
   * @param email - Correo del firmante (se compara normalizado).
   * @param metadata - IP y user-agent de la petición.
   * @returns El correo del firmante, el vencimiento de la invitación nueva y si el correo salió.
   *
   * @throws {IntegrationSignerNotFoundException} (404) Si el documento no es de la organización o
   *   ningún firmante tiene ese correo.
   * @throws {IntegrationAmbiguousSignerException} (409) Si más de un firmante tiene ese correo.
   * @throws {IntegrationInvitationNotResendableException} (409) Si ya no se puede firmar o no es su
   *   turno.
   * @throws {SigningRateLimitException} (429) Si el firmante ya recibió demasiadas invitaciones.
   *
   * @example
   * ```ts
   * await resend.execute(apiClient, 'd-1', 'ana@correo.com', { ipAddress: '10.0.0.1', userAgent: 'erp/1.0' });
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
    documentId: string,
    email: string,
    metadata: { ipAddress: string | null; userAgent: string | null },
  ): Promise<BaseResponse<ResentSigningInvitation>> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId, organizationId: apiClient.organizationId },
    });
    if (!document) throw new IntegrationSignerNotFoundException();

    const signers = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { account: { user: true } },
      order: { signingOrder: 'ASC' },
    });
    const collaborator = findSignerByEmail(signers, email);

    if (
      document.status !== DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE ||
      collaborator.status !== COLLABORATOR_STATUS_ENUM.PENDING
    ) {
      throw new IntegrationInvitationNotResendableException(
        'El documento ya no espera la firma de este firmante',
      );
    }
    if (!isSignerTurn(collaborator, signers, document.isSequential)) {
      throw new IntegrationInvitationNotResendableException(
        'Todavía no es el turno de este firmante',
      );
    }
    if (!isPublicSigningAllowed(collaborator)) {
      throw new IntegrationInvitationNotResendableException(
        'Este firmante firma desde su cuenta de la plataforma',
      );
    }

    const delivered = await this.delivery.deliver({
      document,
      collaborator,
      auditActor: {
        type: 'INTEGRATION_API_CLIENT',
        authMechanism: AUDIT_AUTH_MECHANISM_ENUM.API_KEY,
        apiKeyId: apiClient.apiKeyId,
        ...(metadata.userAgent ? { userAgent: metadata.userAgent } : {}),
      },
      ipAddress: metadata.ipAddress,
    });

    return {
      success: true,
      message: delivered.emailDelivered
        ? 'Invitación reenviada al correo del firmante'
        : 'Se emitió la invitación, pero no se pudo enviar el correo',
      data: {
        email: collaboratorEmail(collaborator),
        invitationExpiresAt: delivered.expiresAt,
        emailDelivered: delivered.emailDelivered,
      },
    };
  }
}
