import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { NotificationEntity } from './entities/notification.entity';
import { SimpleSignatureEntity } from 'src/signature/entities/simple-signature.entity';

import {
  CreateDocumentSignaturesDto,
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  PAYLOAD_SIGNATURE_TYPE_ENUM,
} from './dto/create-document-signatures.dto';

import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from './enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from './enum/signature-type.enum';
import { SIGNEE_STATUS_ENUM } from './enum/signee-status.enum';
import { ACTOR_TYPE_ENUM } from './enum/actor-type.enum';
import { NOTIFICATION_CHANNEL_ENUM } from './enum/notification-channel.enum';
import { VERIFICATION_EVENT_ENUM } from './enum/verification-event.enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';

import { MinioService } from 'src/shared/minio/minio.service';
import { HashService } from 'src/shared/hash/hash.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { AccountMemberService } from 'src/account/account-member.service';
import { VerificationCodeService } from './verification-code.service';
import { NotificationEventsProducer } from 'src/kafka/notification-events.producer';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { MAX_PDF_FILE_SIZE_BYTES } from 'src/shared/constants/file-upload.constants';
import { EmailService } from 'src/shared/email/email.service';
import { DocumentTransactionService } from './document-transaction.service';

const COLABORATOR_TYPE_PAYLOAD_TO_DOMAIN: Record<
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  COLABORATOR_TYPE_ENUM
> = {
  [PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER]: COLABORATOR_TYPE_ENUM.SIGNER,
  [PAYLOAD_COLABORATOR_TYPE_ENUM.VIEWER]: COLABORATOR_TYPE_ENUM.WATCHER,
};

const SIGNATURE_TYPE_PAYLOAD_TO_DOMAIN: Record<
  PAYLOAD_SIGNATURE_TYPE_ENUM,
  SIGNATURE_TYPE_ENUM
> = {
  [PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE]: SIGNATURE_TYPE_ENUM.SIMPLE,
  [PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED]: SIGNATURE_TYPE_ENUM.FIEL,
};

/** Ancho/alto por defecto para el stamp de firma — el payload solo trae page/x/y (ver historia). */
const DEFAULT_SIGNATURE_SIZE = { width: 100, height: 80 };

export interface CreateDocumentSignaturesResult {
  id: string;
  status: DOCUMENT_STATUS_ENUM;
  collaboratorsCount: number;
  notificationsCount: number;
  verificationCodesCount: number;
}

/**
 * Orquesta POST /api/v1/documents/signatures (ver historias "Backend: Orquestación para
 * Creación de Documento y Flujo de Firmas" + "Frontend: Carga de Documentos y Configuración de
 * Firmantes" — la segunda redefinió el contrato de la primera: un solo arreglo `collaborators`
 * con collaboratorType SIGNER/VIEWER, en vez de dos arreglos separados, y multipart con el
 * archivo real en vez de un objectKey pre-subido).
 *
 * Trata a todos los colaboradores como invitación por email (accountId siempre null) — no
 * intenta resolver si ese correo ya tiene cuenta en la plataforma.
 *
 * Crea Document -> Collaborator (+ SimpleSignature por firmante, con su signaturePosition) ->
 * Notification -> verification_code dentro de UNA transacción; los eventos de Kafka (uno por
 * notificación) solo se publican si la transacción hizo commit.
 */
@Injectable()
export class DocumentSignaturesService {
  private readonly logger = new Logger(DocumentSignaturesService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly documentSigningService: PdfSignatureService,
    private readonly accountMemberService: AccountMemberService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly notificationEventsProducer: NotificationEventsProducer,
    private readonly emailService: EmailService,
    private readonly documentTransactionService: DocumentTransactionService,
  ) {}

  async create(
    createdBy: string,
    accountId: string,
    dto: CreateDocumentSignaturesDto,
    file: Express.Multer.File,
    ip: string,
  ): Promise<BaseResponse<CreateDocumentSignaturesResult>> {
    if (!accountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la cuenta activa',
      );
    }
    if (!file) {
      throw new BadRequestException('Archivo no proporcionado');
    }
    if (file.size > MAX_PDF_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `El documento debe pesar menos de ${Math.floor(MAX_PDF_FILE_SIZE_BYTES / (1024 * 1024))}MB`,
      );
    }

    const activeAccount = await this.accountMemberService.assertIsActiveMember(
      createdBy,
      accountId,
    );

    const totalPages = await this.documentSigningService.getPdfPages(file);
    const originalHash = await this.hashService.generateFileHash(file);

    const uploadResponse = await this.minioService.uploadObject(
      { file, name: file.originalname },
      BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    );
    if (uploadResponse.status !== FILE_STATUS_ENUM.FILE_CREATED) {
      throw new Error('Error guardando archivo en bucket Minio');
    }

    const totalSigners = dto.collaborators.filter(
      (c) => c.collaboratorType === PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
    ).length;
    const isSequential = dto.documentData.isSequential ?? true;

    const {
      document,
      notificationEvents,
      verificationCodesCount,
      invitationEmailTargets,
    } = await this.dataSource.transaction(async (manager) => {
        const documentRepo = manager.getRepository(DocumentEntity);
        const collaboratorRepo = manager.getRepository(CollaboratorEntity);
        const notificationRepo = manager.getRepository(NotificationEntity);
        const simpleSignatureRepo = manager.getRepository(
          SimpleSignatureEntity,
        );

        const document = await documentRepo.save(
          documentRepo.create({
            objectKey: uploadResponse.fileId,
            fileName: dto.documentData.fileName,
            fileType: file.mimetype,
            totalPages,
            ipAddress: ip,
            originalHash,
            status: DOCUMENT_STATUS_ENUM.PENDING,
            createdBy,
            accountId,
            organizationId: activeAccount.organizationId,
            requiresApproval: dto.documentData.requiresApproval === true,
            totalSigners,
            isSequential,
          }),
        );

        await this.documentTransactionService.createInitial(
          document.id,
          originalHash,
          manager,
        );

        const notificationEvents: {
          notification: NotificationEntity;
          collaboratorId: string;
        }[] = [];
        // Firmantes de Firma Digital Simple en un documento sin orden (isSequential=false): se
        // les invita por correo a registrarse/iniciar sesión de inmediato, ya que no hay que
        // esperar ningún turno (ver historia "Notificación por Email para Firma Simple y
        // Vinculación de Cuenta"). Se envían fuera de la transacción, igual que los eventos de
        // Kafka más abajo.
        const invitationEmailTargets: {
          to: string;
          name: string;
          collaboratorId: string;
        }[] = [];
        let verificationCodesCount = 0;
        let anyRequiresVerification = false;
        // Bug corregido: este loop nunca asignaba signingOrder a los firmantes (a diferencia de
        // DocumentService.create(), que sí lo hace vía signerIds.map((_, index) => ...)) — con
        // signingOrder siempre null, getNextPendingSigner() (base de "a quién le toca firmar" en
        // sign()/reject()/las notificaciones) no tenía ningún orden real que respetar para
        // documentos isSequential=true creados por este endpoint, que es el único que usa el
        // frontend. Se numera solo entre los SIGNER, en el orden en que vienen en el payload.
        let signerIndex = 0;

        for (const participant of dto.collaborators) {
          const isSigner =
            participant.collaboratorType ===
            PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER;

          let simpleSignatureId: string | null = null;
          if (isSigner && participant.signaturePosition) {
            const simpleSignature = await simpleSignatureRepo.save(
              simpleSignatureRepo.create({
                signatureCoordinates: {
                  x: participant.signaturePosition.x,
                  y: participant.signaturePosition.y,
                  page: participant.signaturePosition.page,
                  ...DEFAULT_SIGNATURE_SIZE,
                },
              }),
            );
            simpleSignatureId = simpleSignature.id;
          }

          const collaborator = await collaboratorRepo.save(
            collaboratorRepo.create({
              documentId: document.id,
              email: participant.email,
              firstName: participant.firstName,
              lastName: participant.lastName,
              rfc: participant.rfc ?? null,
              colaboratorType:
                COLABORATOR_TYPE_PAYLOAD_TO_DOMAIN[
                  participant.collaboratorType
                ],
              signatureType: isSigner
                ? SIGNATURE_TYPE_PAYLOAD_TO_DOMAIN[participant.signatureType!]
                : null,
              simpleSignatureId,
              signingOrder: isSigner ? signerIndex : null,
              status: SIGNEE_STATUS_ENUM.PENDING,
              ipAddress: ip,
            }),
          );
          if (isSigner) {
            signerIndex += 1;
          }

          const notification = await notificationRepo.save(
            notificationRepo.create({
              collaboratorId: collaborator.id,
              documentId: document.id,
              isNotified: false,
              // Siempre WATCHER: este endpoint trata a todos los colaboradores como invitación
              // por email (accountId null) — el criterio es "¿tiene cuenta?", no su rol.
              actorType: ACTOR_TYPE_ENUM.WATCHER,
              notificationChannelSource: NOTIFICATION_CHANNEL_ENUM.EMAIL,
              delivered: false,
            }),
          );
          notificationEvents.push({
            notification,
            collaboratorId: collaborator.id,
          });

          if (
            isSigner &&
            participant.signatureType === PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE &&
            !isSequential
          ) {
            invitationEmailTargets.push({
              to: collaborator.email!,
              name:
                `${collaborator.firstName ?? ''} ${collaborator.lastName ?? ''}`.trim() ||
                collaborator.email!,
              collaboratorId: collaborator.id,
            });
          }

          if (isSigner) {
            // Regla de negocio reforzada en el backend, no solo confiada del payload (ver
            // historia): SIMPLE siempre requiere 2FA sin importar lo que mande el cliente;
            // ADVANCED respeta la elección explícita del usuario en el checkbox.
            const needsVerification =
              participant.signatureType === PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE
                ? true
                : participant.requiresTwoFactorAuth === true;

            if (needsVerification) {
              anyRequiresVerification = true;
              verificationCodesCount += 1;
              await this.verificationCodeService.issue(
                document.id,
                collaborator.id,
                VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
                ip,
                manager,
              );
            }
          }
        }

        if (anyRequiresVerification) {
          await documentRepo.update(document.id, {
            requiresVerification: true,
          });
        }

        return {
          document,
          notificationEvents,
          verificationCodesCount,
          invitationEmailTargets,
        };
      });

    // Fuera de la transacción a propósito: si cualquier paso de arriba lanza, el rollback ya
    // ocurrió y esta línea nunca se alcanza — cero eventos publicados a Kafka.
    for (const { notification, collaboratorId } of notificationEvents) {
      this.notificationEventsProducer.emitCreated({
        notificationId: notification.id,
        documentId: document.id,
        collaboratorId,
        actorType: notification.actorType,
        notificationChannelSource: notification.notificationChannelSource,
        actorUserId: createdBy,
      });
    }

    // Igual que arriba: fuera de la transacción, y best-effort por destinatario — un correo que
    // falla no debe tumbar la creación del documento ni impedir que los demás se envíen (ver
    // historia "Notificación por Email para Firma Simple y Vinculación de Cuenta").
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
    for (const { to, name, collaboratorId } of invitationEmailTargets) {
      const accessUrl =
        `${frontendUrl}/access-document?docId=${document.id}` +
        `&collabId=${collaboratorId}&email=${encodeURIComponent(to)}`;
      try {
        await this.emailService.sendDocumentInvitationNotification(
          to,
          name,
          document.fileName,
          accessUrl,
        );
      } catch (error) {
        this.logger.error(
          `Error enviando invitación de firma simple a ${to} (documento ${document.id}): ${error}`,
        );
      }
    }

    return {
      success: true,
      message: 'Documento y flujo de firmas creados correctamente',
      data: {
        id: document.id,
        status: document.status,
        collaboratorsCount: notificationEvents.length,
        notificationsCount: notificationEvents.length,
        verificationCodesCount,
      },
    };
  }
}
