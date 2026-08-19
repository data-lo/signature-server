import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuid4 } from 'uuid';

import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { NotificationEntity } from './entities/notification.entity';
import { SimpleSignatureEntity } from 'src/signature/entities/simple-signature.entity';

import {
  CreateDocumentSignaturesDto,
  PAYLOAD_COLABORATOR_TYPE_ENUM,
  PAYLOAD_SIGNATURE_TYPE_ENUM,
  REQUIRES_DIFFERENT_SIGNATURES_ENUM,
  SignaturePositionDto,
} from './dto/create-document-signatures.dto';
import { assertNoOverlappingSignaturePositions } from './utils/signature-collision.util';

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
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { VerificationCodeService } from './verification-code.service';
import { NotificationEventsProducer } from 'src/kafka/notification-events.producer';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { MAX_PDF_FILE_SIZE_BYTES } from 'src/shared/constants/file-upload.constants';
import { EmailService } from 'src/shared/email/email.service';
import { DocumentTransactionService } from './document-transaction.service';
import { buildDocumentAccessUrl } from './utils/document-access-url.util';

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

/**
 * `requiresDifferentSignatures` es el mismo dato que `documentData.signatureType` con otro
 * vocabulario (ver DTO): esta tabla existe solo para verificar que un cliente no mande los dos
 * campos contradiciéndose.
 */
const EXPECTED_REQUIRES_DIFFERENT_SIGNATURES: Record<
  PAYLOAD_SIGNATURE_TYPE_ENUM,
  REQUIRES_DIFFERENT_SIGNATURES_ENUM
> = {
  [PAYLOAD_SIGNATURE_TYPE_ENUM.SIMPLE]:
    REQUIRES_DIFFERENT_SIGNATURES_ENUM.SIMPLE,
  [PAYLOAD_SIGNATURE_TYPE_ENUM.ADVANCED]:
    REQUIRES_DIFFERENT_SIGNATURES_ENUM.FIEL,
};

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
 * El tipo de firma es del documento, no de cada firmante (historia "Selección de tipo de firma al
 * crear documentos"): llega en `documentData.signatureType`, admite solo SIMPLE o ADVANCED, y se
 * copia igual a todos los SIGNER — no existe el documento con firmas de tipos distintos.
 *
 * Crea Document -> Collaborator (+ SimpleSignature por firmante, con su arreglo `signatures` —
 * ver historia "Ubicación de firmas por usuario") -> Notification -> verification_code dentro de
 * UNA transacción; los eventos de Kafka (uno por notificación) solo se publican si la
 * transacción hizo commit.
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
    private readonly documentEventsProducer: DocumentEventsProducer,
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

    // Historia "Selección de tipo de firma al crear documentos": el tipo de firma es UNA decisión
    // del documento (SIMPLE o ADVANCED, nada más) y se aplica igual a todos sus firmantes. Se
    // resuelve acá arriba, una sola vez, para que ningún punto del flujo pueda derivar un tipo
    // distinto por colaborador.
    const payloadSignatureType = dto.documentData.signatureType;
    const documentSignatureType =
      SIGNATURE_TYPE_PAYLOAD_TO_DOMAIN[payloadSignatureType];

    // `requiresDifferentSignatures` quedó como espejo redundante del campo de arriba: si un
    // cliente manda los dos y no coinciden, no hay forma de saber cuál refleja la intención real
    // — se rechaza en vez de elegir uno en silencio.
    if (
      dto.requiresDifferentSignatures &&
      dto.requiresDifferentSignatures !==
        EXPECTED_REQUIRES_DIFFERENT_SIGNATURES[payloadSignatureType]
    ) {
      throw new BadRequestException(
        `requiresDifferentSignatures (${dto.requiresDifferentSignatures}) contradice el tipo de firma del documento (${payloadSignatureType})`,
      );
    }

    const totalSigners = dto.collaborators.filter(
      (c) => c.collaboratorType === PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER,
    ).length;

    // `ArrayMinSize(1)` del DTO solo garantiza que haya colaboradores: un documento con puros
    // VIEWER nace en PENDING y no puede completarse nunca porque no hay a quién pedirle una firma.
    if (totalSigners === 0) {
      throw new BadRequestException(
        'El documento debe tener al menos un colaborador de tipo SIGNER',
      );
    }

    const activeAccount = await this.accountMemberService.assertIsActiveMember(
      createdBy,
      accountId,
    );

    // Bug corregido: "requiere aprobación" depende de que exista alguien con permisos dentro de
    // una organización para aprobarlo — una cuenta PERSONAL no tiene miembros ni permisos que
    // ejercer esa aprobación. El frontend ya oculta la opción para cuentas PERSONAL; esto la
    // rechaza también aquí para que un cliente distinto (u otro bug en el frontend) no pueda
    // colar un documento personal con requiresApproval=true que nunca podría aprobarse.
    if (
      dto.documentData.requiresApproval === true &&
      activeAccount.accountType !== ACCOUNT_TYPE_ENUM.ORGANIZATION
    ) {
      throw new BadRequestException(
        'Solo las cuentas de tipo ORGANIZATION pueden requerir aprobación en un documento',
      );
    }

    const totalPages = await this.documentSigningService.getPdfPages(file);
    const originalHash = await this.hashService.generateFileHash(file);

    const uploadResponse = await this.minioService.uploadObject(
      { file, name: file.originalname },
      BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    );
    if (uploadResponse.status !== FILE_STATUS_ENUM.FILE_CREATED) {
      throw new Error('Error guardando archivo en bucket Minio');
    }

    const isSequential = dto.documentData.isSequential ?? true;

    // Defensa en profundidad (ver signature-collision.util.ts): valida ANTES de tocar la base de
    // datos, agrupando por página todas las posiciones de todos los firmantes del payload.
    const positionsByPage = new Map<number, SignaturePositionDto[]>();
    for (const participant of dto.collaborators) {
      for (const position of participant.signatures ?? []) {
        const positionsOnPage = positionsByPage.get(position.page) ?? [];
        positionsOnPage.push(position);
        positionsByPage.set(position.page, positionsOnPage);
      }
    }
    assertNoOverlappingSignaturePositions(positionsByPage);

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

        // Historia "Habilitar ordenamiento Drag and Drop para firmantes requeridos": el frontend
        // manda orderIndex reflejando el orden tras el arrastre manual — si viene en todos los
        // colaboradores, se ordena explícitamente sobre esa base en vez de confiar en que el
        // arreglo ya llegó en el orden correcto (si algún colaborador no lo trae, se conserva el
        // orden de aparición en el payload, comportamiento previo a esta historia).
        const orderedCollaborators = dto.collaborators.every(
          (c) => typeof c.orderIndex === 'number',
        )
          ? [...dto.collaborators].sort(
              (a, b) => a.orderIndex! - b.orderIndex!,
            )
          : dto.collaborators;

        for (const participant of orderedCollaborators) {
          const isSigner =
            participant.collaboratorType ===
            PAYLOAD_COLABORATOR_TYPE_ENUM.SIGNER;

          // Se crea SIEMPRE (incluso con un arreglo vacío) para todo SIGNER de este flujo —
          // `simpleSignatureId` asignado (con o sin posiciones) distingue a estos colaboradores
          // de los creados por el endpoint POST /document más antiguo (que nunca lo asigna y
          // sigue cayendo al apilado automático en finalizeSignedDocument, sin cambios). Un
          // arreglo vacío significa "sin posición: se firma sin estampado visual" (ver historia).
          let simpleSignatureId: string | null = null;
          if (isSigner) {
            const simpleSignature = await simpleSignatureRepo.save(
              simpleSignatureRepo.create({
                signatureCoordinates: (participant.signatures ?? []).map(
                  (position) => ({
                    signatureId: position.signatureId ?? uuid4(),
                    page: position.page,
                    xRatio: position.xRatio,
                    yRatio: position.yRatio,
                    widthRatio: position.widthRatio,
                    heightRatio: position.heightRatio,
                  }),
                ),
              }),
            );
            simpleSignatureId = simpleSignature.id;
          }

          const collaborator = await collaboratorRepo.save(
            collaboratorRepo.create({
              documentId: document.id,
              // Normalizado igual que `users.email` (ver UserService): mientras el colaborador no
              // tiene cuenta vinculada, este correo es su única identidad, y todo lo que lo
              // empareja después —listado "Por firmar", vinculación de cuenta, firma y rechazo—
              // lo compara contra el correo ya normalizado del usuario. Guardarlo tal cual se
              // tecleó dejaba invisibles en "Por firmar" a los firmantes invitados con
              // mayúsculas (ver el bug corregido en DocumentService.findWithFilters).
              email: participant.email.toLowerCase(),
              firstName: participant.firstName,
              lastName: participant.lastName,
              // Solo el VIEWER guarda RFC: para un firmante el dato ya no se pide al crear el
              // documento, y el del flujo avanzado sale del certificado de e.firma al firmar (ver
              // `CollaboratorPayloadDto.rfc`). Se descarta explícitamente lo que mande el cliente.
              rfc: isSigner ? null : (participant.rfc ?? null),
              colaboratorType:
                COLABORATOR_TYPE_PAYLOAD_TO_DOMAIN[
                  participant.collaboratorType
                ],
              signatureType: isSigner ? documentSignatureType : null,
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
            documentSignatureType === SIGNATURE_TYPE_ENUM.SIMPLE &&
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
            // historia): un documento de firma SIMPLE siempre requiere 2FA sin importar lo que
            // mande el cliente; en ADVANCED se respeta la elección explícita del usuario en el
            // checkbox, firmante por firmante.
            const needsVerification =
              documentSignatureType === SIGNATURE_TYPE_ENUM.SIMPLE
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
    //
    // Bug corregido: este endpoint nunca publicaba DOCUMENT_KAFKA_TOPICS.CREATED (solo el tópico
    // de NotificationEventsProducer, uno por colaborador, para el envío de correo) — por lo que
    // DocumentEventsConsumer.handleCreated() nunca corría para documentos creados por esta vía
    // (la única que usa el frontend), y el ledger global de auditoría (AuditChainService, ver
    // historia "Módulo de Auditoría e Integridad Global de BD") arrancaba su cadena directo en el
    // primer evento de firma en vez de en la creación del documento.
    this.documentEventsProducer.emitCreated({
      documentId: document.id,
      fileName: document.fileName,
      actorUserId: createdBy,
    });

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
    for (const { to, name, collaboratorId } of invitationEmailTargets) {
      const accessUrl = buildDocumentAccessUrl(document.id, collaboratorId, to);
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
