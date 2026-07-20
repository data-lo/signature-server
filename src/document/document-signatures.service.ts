import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { NotificationEntity } from './entities/notification.entity';

import {
  CollaboratorPayloadDto,
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

import { MinioService } from 'src/shared/minio/minio.service';
import { HashService } from 'src/shared/hash/hash.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { AccountMemberService } from 'src/account/account-member.service';
import { VerificationCodeService } from './verification-code.service';
import { NotificationEventsProducer } from 'src/kafka/notification-events.producer';
import { BaseResponse } from 'src/interfaces/api-response.dto';

const COLABORATOR_TYPE_PAYLOAD_TO_DOMAIN: Record<
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  COLABORATOR_TYPE_ENUM
> = {
  [PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER]: COLABORATOR_TYPE_ENUM.SIGNER,
  [PAYLOAD_COLABORATOR_TYPE_ENUM.REVIEWER]: COLABORATOR_TYPE_ENUM.REVIEWER,
};

const SIGNATURE_TYPE_PAYLOAD_TO_DOMAIN: Record<
  PAYLOAD_SIGNATURE_TYPE_ENUM,
  SIGNATURE_TYPE_ENUM
> = {
  [PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE]: SIGNATURE_TYPE_ENUM.SIMPLE,
  [PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED]: SIGNATURE_TYPE_ENUM.FIEL,
};

interface NormalizedParticipant {
  email: string;
  isViewer: boolean;
  colaboratorType: COLABORATOR_TYPE_ENUM;
  signatureType: PAYLOAD_SIGNATURE_TYPE_ENUM | null;
  signingOrder: number | null;
  rfc: string | null;
  requiresVerification: boolean;
}

export interface CreateDocumentSignaturesResult {
  id: string;
  status: DOCUMENT_STATUS_ENUM;
  collaboratorsCount: number;
  notificationsCount: number;
  verificationCodesCount: number;
}

/**
 * Orquesta POST /api/v1/documents/signatures (ver historia "Backend: Orquestación para
 * Creación de Documento y Flujo de Firmas"). A diferencia de DocumentService.create() (que
 * sube el archivo multipart y arma colaboradores a partir de userIds de la plataforma), este
 * flujo:
 *  1. Recibe el archivo ya subido a MinIO (`documentData.objectKey`) — no lo sube, solo lo lee
 *     para calcular hash/páginas.
 *  2. Trata a todos los colaboradores/viewers como invitación por email (accountId siempre
 *     null) — no intenta resolver si ese correo ya tiene cuenta en la plataforma.
 *  3. Crea Document -> Collaborator -> Notification -> VerificationCode dentro de UNA sola
 *     transacción de Postgres, y solo publica los eventos de Kafka (uno por notificación) si
 *     la transacción completa hizo commit — un fallo en cualquier paso hace rollback completo
 *     y cero eventos publicados (ver Escenario 2 de la historia).
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
  ) {}

  async create(
    createdBy: string,
    accountId: string,
    dto: CreateDocumentSignaturesDto,
    ip: string,
  ): Promise<BaseResponse<CreateDocumentSignaturesResult>> {
    if (!accountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la cuenta activa',
      );
    }
    const activeAccount = await this.accountMemberService.assertIsActiveMember(
      createdBy,
      accountId,
    );

    const participants = this.normalizeParticipants(dto);

    // Escenario 3: se valida (y se rechaza con 400) ANTES de tocar MinIO o abrir la
    // transacción — un payload inválido no debe generar ningún efecto secundario.
    this.assertRfcForAdvancedSigners(participants);

    const fileBuffer = await this.readUploadedFile(dto.documentData.objectKey);
    const totalPages = await this.documentSigningService.getPdfPages({
      buffer: fileBuffer,
    } as Express.Multer.File);
    const originalHash = await this.hashService.generateFileHash(fileBuffer);

    const totalSigners = participants.filter(
      (p) => !p.isViewer && p.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER,
    ).length;

    const { document, notificationEvents, verificationCodesCount } =
      await this.dataSource.transaction(async (manager) => {
        const documentRepo = manager.getRepository(DocumentEntity);
        const collaboratorRepo = manager.getRepository(CollaboratorEntity);
        const notificationRepo = manager.getRepository(NotificationEntity);

        const document = await documentRepo.save(
          documentRepo.create({
            objectKey: dto.documentData.objectKey,
            fileName: dto.documentData.fileName,
            fileType: dto.documentData.fileType,
            totalPages,
            ipAddress: ip,
            originalHash,
            status: DOCUMENT_STATUS_ENUM.PENDING,
            createdBy,
            accountId,
            organizationId: activeAccount.organizationId,
            visibilityLevel: dto.documentData.visibilityLevel ?? 0,
            totalSigners,
          }),
        );

        const notificationEvents: {
          notification: NotificationEntity;
          collaboratorId: string;
        }[] = [];
        let verificationCodesCount = 0;
        let anyRequiresVerification = false;

        for (const participant of participants) {
          const collaborator = await collaboratorRepo.save(
            collaboratorRepo.create({
              documentId: document.id,
              email: participant.email,
              colaboratorType: participant.colaboratorType,
              signingOrder: participant.signingOrder,
              signatureType: participant.signatureType
                ? SIGNATURE_TYPE_PAYLOAD_TO_DOMAIN[participant.signatureType]
                : null,
              status: SIGNEE_STATUS_ENUM.PENDING,
              ipAddress: ip,
            }),
          );

          const notification = await notificationRepo.save(
            notificationRepo.create({
              collaboratorId: collaborator.id,
              documentId: document.id,
              isNotified: false,
              // Siempre WATCHER: este endpoint trata a todos los colaboradores como invitación
              // por email (accountId null, ver docblock de la clase) — igual que
              // DocumentEventsConsumer.persistNotifications, el criterio es "¿tiene cuenta?".
              actorType: ACTOR_TYPE_ENUM.WATCHER,
              notificationChannelSource: NOTIFICATION_CHANNEL_ENUM.EMAIL,
              delivered: false,
            }),
          );
          notificationEvents.push({
            notification,
            collaboratorId: collaborator.id,
          });

          if (!participant.isViewer) {
            const needsVerification =
              participant.requiresVerification ||
              participant.signatureType ===
                PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED;

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

        return { document, notificationEvents, verificationCodesCount };
      });

    // Fuera de la transacción a propósito (Escenario 2): si cualquier paso de arriba lanza, el
    // rollback ya ocurrió y esta línea nunca se alcanza — cero eventos publicados a Kafka.
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

  private normalizeParticipants(
    dto: CreateDocumentSignaturesDto,
  ): NormalizedParticipant[] {
    const signersAndReviewers: NormalizedParticipant[] = dto.collaborators.map(
      (c: CollaboratorPayloadDto) => ({
        email: c.email,
        isViewer: false,
        colaboratorType: COLABORATOR_TYPE_PAYLOAD_TO_DOMAIN[c.colaboratorType],
        signatureType: c.signatureType ?? dto.signatureType ?? null,
        signingOrder: c.signingOrder ?? null,
        rfc: c.rfc ?? null,
        requiresVerification: c.requiresVerification === true,
      }),
    );

    const viewers: NormalizedParticipant[] = (dto.viewers ?? []).map((v) => ({
      email: v.email,
      isViewer: true,
      colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
      signatureType: null,
      signingOrder: null,
      rfc: null,
      requiresVerification: false,
    }));

    return [...signersAndReviewers, ...viewers];
  }

  /** Escenario 3: firma ADVANCED sin rfc se rechaza con 400 antes de tocar BD/MinIO. */
  private assertRfcForAdvancedSigners(
    participants: NormalizedParticipant[],
  ): void {
    const missingRfc = participants.find(
      (p) =>
        !p.isViewer &&
        p.signatureType === PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED &&
        !p.rfc,
    );

    if (missingRfc) {
      throw new BadRequestException(
        `El colaborador '${missingRfc.email}' tiene signatureType ADVANCED — el campo rfc es obligatorio`,
      );
    }
  }

  private async readUploadedFile(objectKey: string): Promise<Buffer> {
    try {
      return await this.minioService.getFileInBytesFormat(
        objectKey,
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );
    } catch (error) {
      throw new BadRequestException(
        `No se encontró el archivo '${objectKey}' en el almacenamiento: ${error}`,
      );
    }
  }
}
