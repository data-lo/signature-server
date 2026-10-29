import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IntegrationApiClient } from 'src/api-key/interfaces/integration-api-client.interface';
import { AuditService } from 'src/audit/audit.service';
import {
  AUDIT_AUTH_MECHANISM_ENUM,
  AuditAction,
} from 'src/audit/schema/audit-document';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { isPublicSigningAllowed } from 'src/signing-invitation/public-signing-eligibility';
import { SigningInvitationService } from 'src/signing-invitation/signing-invitation.service';
import { SigningLaunchService } from 'src/signing-invitation/signing-launch.service';
import {
  LAUNCH_ISSUE,
  SigningRateLimitService,
} from 'src/signing-invitation/signing-rate-limit.service';

import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { DocumentEntity } from '../../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { collaboratorEmail } from '../../utils/collaborator-display.util';
import { isSignerTurn } from '../../utils/next-signer.util';
import {
  IntegrationAmbiguousSignerException,
  IntegrationInvitationNotResendableException,
  IntegrationSignerNotFoundException,
  IntegrationSignerNotInTurnException,
} from '../exceptions/integration-document.exceptions';

/** Acceso temporal emitido: la URL de un solo uso y su vencimiento. */
export interface IntegrationSigningAccess {
  url: string;
  expiresAt: Date;
}

/**
 * `POST /integration/documents/:documentId/signing-access`: el backend del tercero pide, para un
 * firmante, una URL temporal (`/sign/launch/:token`, cinco minutos, un solo uso) que abrirá desde
 * su portal.
 *
 * El correo sólo LOCALIZA al colaborador dentro del documento: no autoriza la firma. Abrir la URL
 * lleva a la misma validación del código enviado al correo de la invitación que el enlace del
 * correo, así que entregar una URL a otra persona no le permite firmar.
 *
 * Reglas: documento de la organización de la llave (la organización sale de la llave), un único
 * firmante con ese correo, pendiente, en su turno y que pueda firmar desde la invitación pública.
 * Reutiliza la invitación vigente del firmante (o emite una, sin enviar correo), guarda sólo el hash
 * del token y audita la emisión con el `apiKeyId`.
 */
@Injectable()
export class IssueIntegrationSigningAccessUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly invitations: SigningInvitationService,
    private readonly launches: SigningLaunchService,
    private readonly limits: SigningRateLimitService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Emite el acceso temporal de un firmante.
   *
   * @param apiClient - Cliente autenticado por la API key.
   * @param documentId - Documento de la ruta.
   * @param email - Correo del firmante (se compara normalizado).
   * @param metadata - IP y user-agent del backend del tercero.
   * @returns La URL de un solo uso y su vencimiento.
   *
   * @throws {IntegrationSignerNotFoundException} (404) El documento no es de la organización o
   *   ningún firmante tiene ese correo.
   * @throws {IntegrationAmbiguousSignerException} (409) Más de un firmante tiene ese correo.
   * @throws {IntegrationInvitationNotResendableException} (409) El documento ya no espera esa firma
   *   o el firmante firma desde su cuenta.
   * @throws {IntegrationSignerNotInTurnException} (409, `WAITING_FOR_PREVIOUS_SIGNER`) Todavía no
   *   es su turno.
   * @throws {SigningRateLimitException} (429) Demasiados accesos para el firmante.
   *
   * @example
   * ```ts
   * const { data } = await issueSigningAccess.execute(apiClient, 'd-1', 'ana@correo.com', metadata);
   * data.url; // 'https://app.firmalo.mx/sign/launch/sla_…'
   * ```
   */
  async execute(
    apiClient: IntegrationApiClient,
    documentId: string,
    email: string,
    metadata: { ipAddress: string | null; userAgent: string | null },
  ): Promise<BaseResponse<IntegrationSigningAccess>> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId, organizationId: apiClient.organizationId },
    });
    if (!document) throw new IntegrationSignerNotFoundException();

    const signers = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { account: { user: true } },
      order: { signingOrder: 'ASC' },
    });
    const normalized = email.trim().toLowerCase();
    const matches = signers.filter(
      (signer) => collaboratorEmail(signer).toLowerCase() === normalized,
    );
    if (matches.length === 0) throw new IntegrationSignerNotFoundException();
    if (matches.length > 1) throw new IntegrationAmbiguousSignerException();
    const [collaborator] = matches;

    if (
      document.status !== DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE ||
      collaborator.status !== COLLABORATOR_STATUS_ENUM.PENDING
    ) {
      throw new IntegrationInvitationNotResendableException(
        'El documento ya no espera la firma de este firmante',
      );
    }
    if (!isSignerTurn(collaborator, signers, document.isSequential)) {
      throw new IntegrationSignerNotInTurnException();
    }
    if (!isPublicSigningAllowed(collaborator)) {
      throw new IntegrationInvitationNotResendableException(
        'Este firmante firma desde su cuenta de la plataforma',
      );
    }

    await this.limits.consume(`collab:${collaborator.id}`, [LAUNCH_ISSUE]);

    const invitation = await this.invitations.ensureOpen({
      documentId,
      collaboratorId: collaborator.id,
    });
    const { launch, url } = await this.launches.issue({
      invitationId: invitation.id,
      apiKeyId: apiClient.apiKeyId,
      ipAddress: metadata.ipAddress,
    });

    void this.auditService.create({
      documentId,
      operation: AuditAction.SIGNING_LAUNCH_ISSUED,
      ipAddress: metadata.ipAddress ?? '0.0.0.0',
      actor: {
        type: 'INTEGRATION_API_CLIENT',
        authMechanism: AUDIT_AUTH_MECHANISM_ENUM.API_KEY,
        apiKeyId: apiClient.apiKeyId,
        invitationId: invitation.id,
        collaboratorId: collaborator.id,
        accessChannel: 'THIRD_PARTY_PORTAL',
        ...(metadata.userAgent ? { userAgent: metadata.userAgent } : {}),
      },
      result: 'SUCCESS',
    });

    return {
      success: true,
      message: 'Acceso temporal de firma generado',
      data: { url, expiresAt: launch.expiresAt },
    };
  }
}
