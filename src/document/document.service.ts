// NestJS core
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

// TypeORM
import { In, Repository } from 'typeorm';

// Entities
import { DocumentEntity } from './entities/document.entity';
import { CollaboratorEntity } from './entities/collaborator.entity';
import { UserEntity } from 'src/user/entities/user.entity';

// DTOs
import { CreateDocumentDto } from './dto/create-document.dto';

// Enums
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { COLABORATOR_TYPE_ENUM } from './enum/colaborator-type.enum';
import { SIGNEE_STATUS_ENUM } from './enum/signee-status.enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';

// Interfaces & payloads
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DEFAULT_COORDINATES } from 'src/shared/document-signing/interfaces/default-signing-coordinates.interface';
import { SignatureCoordinates } from 'src/shared/document-signing/interfaces/signature-coordinates.interface';

// Services
import { MinioService } from '../shared/minio/minio.service';
import { HashService } from '../shared/hash/hash.service';
import { UserService } from '../user/user.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { EmailService } from 'src/shared/email/email.service';
import { AuditService } from 'src/audit/audit.service';
import { AuditAction } from 'src/audit/schema/audit-document';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { GetDocumentsQueryDto } from './dto/get-documents-query.dto';
import { SignatureCoordinatesDto } from './dto/signature-coordinates.dto';
import { UpdateDocumentData } from './interfaces/responses/document-update-response';
import { AccountMemberService } from 'src/account/account-member.service';
import { getNextPendingSigner, isSignerTurn } from './utils/next-signer.util';
import { VerificationCodeService } from './verification-code.service';
import { VERIFICATION_EVENT_ENUM } from './enum/verification-event.enum';
import { MAX_PDF_FILE_SIZE_BYTES } from 'src/shared/constants/file-upload.constants';

const SIGNATURE_STAMP_VERTICAL_GAP = 40;

/** Nombre a mostrar de un colaborador: el de su cuenta si existe, o su email si fue invitado solo por correo. */
function collaboratorDisplayName(collaborator: CollaboratorEntity): string {
  return collaborator.user
    ? `${collaborator.user.firstName} ${collaborator.user.lastName}`
    : (collaborator.email ?? '');
}

/** Email de contacto de un colaborador: el de su cuenta si existe, o el email con el que fue invitado. */
function collaboratorEmail(collaborator: CollaboratorEntity): string {
  return collaborator.user?.email ?? collaborator.email ?? '';
}

@Injectable()
export class DocumentService {
  logger = new Logger(DocumentService.name);

  private readonly STATUS_BUCKET_MAP: Record<
    DOCUMENT_STATUS_ENUM,
    BUCKET_TYPES_ENUM
  > = {
    [DOCUMENT_STATUS_ENUM.CANCELLED]: BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.REJECTED]: BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.SIGNED]: BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING]:
      BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.PENDING]: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.CREATED]: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    [DOCUMENT_STATUS_ENUM.EXPIRED]: BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
  };

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly userService: UserService,
    private readonly documentSigningSerivice: PdfSignatureService,
    private readonly signatureService: SignatureService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
    private readonly accountMemberService: AccountMemberService,
    private readonly verificationCodeService: VerificationCodeService,
  ) {}

  /** Sube el archivo a Minio, genera su hash y registra el documento y sus colaboradores (firmantes/watchers/reviewers) en la base de datos. */
  async create(
    createdBy: string,
    accountId: string,
    createDocumentDto: CreateDocumentDto,
    file: Express.Multer.File,
    ip: string,
  ): Promise<BaseResponse> {
    try {
      if (!accountId) {
        throw new BadRequestException(
          'Falta el header X-Account-Id de la cuenta activa',
        );
      }
      const activeAccount = await this.accountMemberService.assertIsActiveMember(
        createdBy,
        accountId,
      );

      if (!file) {
        throw new BadRequestException('Archivo no proporcionado');
      }

      if (file.size > MAX_PDF_FILE_SIZE_BYTES) {
        throw new BadRequestException(
          `El documento debe pesar menos de ${Math.floor(MAX_PDF_FILE_SIZE_BYTES / (1024 * 1024))}MB`,
        );
      }

      const {
        signerIds,
        watcherIds,
        watcherEmails,
        reviewerIds,
        reviewerEmails,
        signatureCoordinates,
      } = createDocumentDto;

      // Solo los firmantes deben tener cuenta en la plataforma (necesitan firma/INE
      // registradas para poder firmar) — watchers y reviewers sí pueden invitarse solo por
      // email, ya que no necesitan cuenta para observar/revisar.
      const allParticipantIds = [
        ...signerIds,
        ...(watcherIds ?? []),
        ...(reviewerIds ?? []),
      ];
      const uniqueParticipantIds = new Set(allParticipantIds);
      if (uniqueParticipantIds.size !== allParticipantIds.length) {
        throw new BadRequestException(
          'No puedes seleccionar al mismo usuario más de una vez entre firmantes, watchers y reviewers',
        );
      }

      const allParticipantEmails = [
        ...(watcherEmails ?? []),
        ...(reviewerEmails ?? []),
      ];
      const uniqueParticipantEmails = new Set(
        allParticipantEmails.map((email) => email.toLowerCase()),
      );
      if (uniqueParticipantEmails.size !== allParticipantEmails.length) {
        throw new BadRequestException(
          'No puedes invitar al mismo correo más de una vez entre watchers y reviewers',
        );
      }

      const duplicateNameDocument = await this.documentRepository.findOne({
        where: {
          createdBy,
          fileName: file.originalname,
          status: In([
            DOCUMENT_STATUS_ENUM.CREATED,
            DOCUMENT_STATUS_ENUM.PENDING,
          ]),
        },
      });
      if (duplicateNameDocument) {
        throw new BadRequestException(
          `Ya tienes un documento con el nombre "${file.originalname}" pendiente de firma. Renómbralo o espera a que finalice su proceso de firma.`,
        );
      }

      await Promise.all(
        allParticipantIds.map((userId) => this.userService.findOne(userId)),
      );

      const minioUploadDocumentResponse = await this.minioService.uploadObject(
        { file, name: file.originalname },
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );
      const pdfPages = await this.documentSigningSerivice.getPdfPages(file);

      if (
        minioUploadDocumentResponse.status !== FILE_STATUS_ENUM.FILE_CREATED
      ) {
        throw new Error('Error guardando archivo en bucket Minio');
      }

      const hashBefore = await this.hashService.generateFileHash(file);

      const document = this.documentRepository.create({
        objectKey: minioUploadDocumentResponse.fileId,
        fileName: file.originalname,
        fileType: file.mimetype,
        totalPages: pdfPages,
        ipAddress: ip,
        originalHash: hashBefore,
        signatureCoordinates: signatureCoordinates ?? DEFAULT_COORDINATES,
        createdBy,
        accountId,
        // Clave real de aislamiento multi-tenant para contexto de organización (ver plan de
        // migración ER-V2, Fase 5, decisión D5): accountId ahora es una fila por usuario, así
        // que ya no agrupa a todos los miembros de una misma organización. organizationId sí.
        organizationId: activeAccount.organizationId,
        totalSigners: signerIds.length,
      });

      const savedDocument = await this.documentRepository.save(document);

      const collaborators = [
        ...signerIds.map((userId, index) =>
          this.collaboratorRepository.create({
            documentId: savedDocument.id,
            userId,
            colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
            signingOrder: index,
            ipAddress: ip,
          }),
        ),
        ...(watcherIds ?? []).map((userId) =>
          this.collaboratorRepository.create({
            documentId: savedDocument.id,
            userId,
            colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
            ipAddress: ip,
          }),
        ),
        ...(watcherEmails ?? []).map((email) =>
          this.collaboratorRepository.create({
            documentId: savedDocument.id,
            email,
            colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
            ipAddress: ip,
          }),
        ),
        ...(reviewerIds ?? []).map((userId) =>
          this.collaboratorRepository.create({
            documentId: savedDocument.id,
            userId,
            colaboratorType: COLABORATOR_TYPE_ENUM.REVIEWER,
            ipAddress: ip,
          }),
        ),
        ...(reviewerEmails ?? []).map((email) =>
          this.collaboratorRepository.create({
            documentId: savedDocument.id,
            email,
            colaboratorType: COLABORATOR_TYPE_ENUM.REVIEWER,
            ipAddress: ip,
          }),
        ),
      ];

      await this.collaboratorRepository.save(collaborators);

      void this.auditService.create({
        documentId: savedDocument.id,
        operation: AuditAction.DOCUMENT_CREATED,
        ipAddress: ip,
        users: [{ userId: createdBy, action: AuditAction.DOCUMENT_CREATED }],
      });
      this.documentEventsProducer.emitCreated({
        documentId: savedDocument.id,
        fileName: savedDocument.fileName,
        actorUserId: createdBy,
      });

      const url = await this.getDocumentMinioURL(savedDocument.id);
      const { signers, watchers, reviewers } = await this.getCollaboratorNames(
        savedDocument.id,
      );
      const requestedBy = await this.userService.findOne(createdBy);

      return {
        success: true,
        message: 'Documento registrado y pendiente de firma correctamente',
        data: {
          id: savedDocument.id,
          fileName: savedDocument.fileName,
          fileType: savedDocument.fileType,
          totalPages: savedDocument.totalPages,
          signers,
          watchers,
          reviewers,
          creator: `${requestedBy.firstName} ${requestedBy.lastName}`,
          status: savedDocument.status,
          secureUrl: url.secureUrl,
          expiresIn: url.expiresIn,
        },
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      )
        throw error;
      throw new Error(`Error creando documento para firma: ${error}`);
    }
  }

  private async getCollaboratorNames(documentId: string): Promise<{
    signers: string[];
    watchers: string[];
    reviewers: string[];
  }> {
    const collaborators = await this.collaboratorRepository.find({
      where: { documentId },
      relations: { user: true },
      order: { signingOrder: 'ASC' },
    });

    const byType = (type: COLABORATOR_TYPE_ENUM) =>
      collaborators
        .filter((c) => c.colaboratorType === type)
        .map(collaboratorDisplayName);

    return {
      signers: byType(COLABORATOR_TYPE_ENUM.SIGNER),
      watchers: byType(COLABORATOR_TYPE_ENUM.WATCHER),
      reviewers: byType(COLABORATOR_TYPE_ENUM.REVIEWER),
    };
  }

  async findWithFilters(
    callerId: string,
    accountId: string,
    query: GetDocumentsQueryDto,
  ) {
    if (!accountId) {
      throw new BadRequestException(
        'Falta el header X-Account-Id de la cuenta activa',
      );
    }
    const activeAccount = await this.accountMemberService.assertIsActiveMember(
      callerId,
      accountId,
    );

    const {
      id,
      participantEmail,
      email,
      status,
      dateFrom,
      dateTo,
      signedDateFrom,
      signedDateTo,
      fileName,
      participantName,
      myTurnOnly,
      page,
      limit,
      withUrl,
    } = query;

    // Contexto de organización: todos los miembros comparten organizationId, así que ese es el
    // filtro real (accountId es una fila por usuario desde la Fase 5, ver decisión D5 del plan
    // de migración ER-V2). Contexto personal: accountId sigue sirviendo (1 miembro = 1 fila).
    const qb = this.documentRepository
      .createQueryBuilder('document')
      .where(
        activeAccount.organizationId
          ? 'document.organizationId = :organizationId'
          : 'document.accountId = :accountId',
        activeAccount.organizationId
          ? { organizationId: activeAccount.organizationId }
          : { accountId },
      )
      .leftJoinAndSelect('document.requestedBy', 'requester')
      .leftJoinAndSelect('document.collaborators', 'collaborator')
      .leftJoinAndSelect('collaborator.user', 'collaboratorUser')
      .orderBy('document.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (id) {
      qb.andWhere('document.id = :id', { id });
    }

    if (participantEmail) {
      qb.andWhere(
        `document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN users u ON u.id = c.user_id
          WHERE u.email = :participantEmail OR c.email = :participantEmail
        )`,
        { participantEmail },
      );
    }

    if (email) {
      qb.andWhere(
        `(requester.email = :email OR document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN users u ON u.id = c.user_id
          WHERE u.email = :email OR c.email = :email
        ))`,
        { email },
      );
    }

    if (status) {
      qb.andWhere('document.status = :status', { status });
    }

    if (dateFrom) {
      qb.andWhere('document.createdAt >= :dateFrom', {
        dateFrom: new Date(dateFrom),
      });
    }

    if (dateTo) {
      qb.andWhere('document.createdAt <= :dateTo', {
        dateTo: new Date(dateTo),
      });
    }

    if (signedDateFrom) {
      qb.andWhere('document.signedAt >= :signedDateFrom', {
        signedDateFrom: new Date(signedDateFrom),
      });
    }

    if (signedDateTo) {
      qb.andWhere('document.signedAt <= :signedDateTo', {
        signedDateTo: new Date(signedDateTo),
      });
    }

    if (fileName) {
      qb.andWhere('document.fileName ILIKE :fileName', {
        fileName: `%${fileName}%`,
      });
    }

    if (participantName) {
      qb.andWhere(
        `document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN users u ON u.id = c.user_id
          WHERE u.first_name ILIKE :participantName
             OR u.last_name ILIKE :participantName
             OR u.email ILIKE :participantName
             OR c.email ILIKE :participantName
        )`,
        { participantName: `%${participantName}%` },
      );
    }

    if (myTurnOnly && participantEmail) {
      qb.andWhere(
        `document.id IN (
          SELECT c.document_id FROM collaborators c
          INNER JOIN users u ON u.id = c.user_id
          WHERE u.email = :participantEmail
            AND c.colaborator_type = 'signer'
            AND c.status = 'pending'
            AND c.signing_order = (
              SELECT MIN(c2.signing_order) FROM collaborators c2
              WHERE c2.document_id = c.document_id
                AND c2.colaborator_type = 'signer'
                AND c2.status = 'pending'
            )
        )`,
        { participantEmail },
      );
    }

    const [documents, total] = await qb.getManyAndCount();

    const data = await Promise.all(
      documents.map(async (doc) => {
        const byType = (type: COLABORATOR_TYPE_ENUM) =>
          (doc.collaborators ?? [])
            .filter((c) => c.colaboratorType === type)
            .sort((a, b) => (a.signingOrder ?? 0) - (b.signingOrder ?? 0))
            .map(collaboratorDisplayName);

        const base = {
          id: doc.id,
          fileName: doc.fileName,
          fileType: doc.fileType,
          signers: byType(COLABORATOR_TYPE_ENUM.SIGNER),
          watchers: byType(COLABORATOR_TYPE_ENUM.WATCHER),
          reviewers: byType(COLABORATOR_TYPE_ENUM.REVIEWER),
          creator: `${doc.requestedBy.firstName} ${doc.requestedBy.lastName}`,
          totalPages: doc.totalPages,
          status: doc.status,
          createdAt: doc.createdAt,
        };

        if (!withUrl) {
          return base;
        }

        const bucket =
          this.STATUS_BUCKET_MAP[doc.status] ??
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS;
        const { secureUrl, expiresIn } = await this.minioService.getFile(
          doc.objectKey,
          bucket,
        );

        return { ...base, secureUrl, expiresIn };
      }),
    );

    return {
      success: true,
      message: 'Documentos obtenidos correctamente',
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
    };
  }

  /** Obtiene el detalle de un documento para la pantalla de firma, incluyendo el rol/turno del usuario autenticado. */
  async findDetailForUser(documentId: string, currentUserId: string) {
    const document = await this.documentRepository.findOne({
      where: { id: documentId },
      relations: { requestedBy: true, collaborators: { user: true } },
    });

    if (!document) {
      throw new NotFoundException(
        `El documento con id ${documentId} no se encuentra`,
      );
    }

    const isCreator = document.createdBy === currentUserId;
    const myParticipant = document.collaborators.find(
      (c) => c.userId === currentUserId,
    );

    if (!isCreator && !myParticipant) {
      throw new ForbiddenException('No tienes acceso a este documento');
    }

    const nextSigner = getNextPendingSigner(document.collaborators);

    const isMyTurn = Boolean(
      myParticipant &&
      myParticipant.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER &&
      nextSigner?.id === myParticipant.id,
    );

    const bucket =
      this.STATUS_BUCKET_MAP[document.status] ??
      BUCKET_TYPES_ENUM.CREATED_DOCUMENTS;
    const { secureUrl, expiresIn } = await this.minioService.getFile(
      document.objectKey,
      bucket,
    );

    const canAct =
      document.status === DOCUMENT_STATUS_ENUM.PENDING &&
      isMyTurn &&
      myParticipant?.status === SIGNEE_STATUS_ENUM.PENDING;

    const canRequestCancellation =
      isCreator && document.status === DOCUMENT_STATUS_ENUM.SIGNED;

    const canConfirmCancellation =
      document.status === DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING &&
      myParticipant?.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER;

    return {
      success: true,
      message: 'Documento obtenido correctamente',
      data: {
        id: document.id,
        fileName: document.fileName,
        fileType: document.fileType,
        totalPages: document.totalPages,
        status: document.status,
        creator: `${document.requestedBy.firstName} ${document.requestedBy.lastName}`,
        secureUrl,
        expiresIn,
        participants: document.collaborators
          .sort((a, b) => (a.signingOrder ?? 0) - (b.signingOrder ?? 0))
          .map((c) => ({
            id: c.id,
            userId: c.userId,
            email: collaboratorEmail(c),
            name: collaboratorDisplayName(c),
            role: c.colaboratorType,
            status: c.status,
            cancellationReason: c.cancellationReason,
          })),
        myRole: myParticipant?.colaboratorType ?? (isCreator ? 'creator' : null),
        myStatus: myParticipant?.status ?? null,
        canSign: canAct,
        canReject: canAct,
        canRequestCancellation,
        canConfirmCancellation,
      },
    };
  }

  /** Genera y retorna la URL segura del archivo en Minio según el estatus del documento. */
  async getDocumentMinioURL(documentId: string) {
    try {
      const document = await this.findOne(documentId);
      const bucket = this.STATUS_BUCKET_MAP[document.status];
      const fileResponse = await this.minioService.getFile(
        document.objectKey,
        bucket,
      );
      return fileResponse;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new Error(`Error obteniendo URL del Documento: ${error}`);
    }
  }

  /** Busca un documento por su UUID y lanza NotFoundException si no existe. */
  async findOne(documentId: string): Promise<DocumentEntity> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId },
    });
    if (!document) {
      throw new NotFoundException(
        `El documento con id ${documentId} no se encuentra`,
      );
    }
    return document;
  }

  /** Verifica si el usuario tiene acceso al documento (creador o colaborador). Usado para proteger la descarga del archivo. */
  async assertUserHasAccess(
    documentId: string,
    userId: string,
  ): Promise<DocumentEntity> {
    const document = await this.findOne(documentId);
    if (document.createdBy === userId) {
      return document;
    }
    const collaborator = await this.collaboratorRepository.findOne({
      where: { documentId, userId },
    });
    if (!collaborator) {
      throw new ForbiddenException('No tienes acceso a este documento');
    }
    return document;
  }

  /** Actualiza los datos de un documento y opcionalmente reemplaza su archivo en Minio. Solo permite documentos en estatus CREATED. */
  async update(
    documentId: string,
    currentUserId: string,
    signatureCoordinatesDto?: SignatureCoordinatesDto,
    fileToReplace?: Express.Multer.File,
  ): Promise<BaseResponse<UpdateDocumentData>> {
    try {
      const document = await this.findOne(documentId);

      if (!signatureCoordinatesDto && !fileToReplace) {
        throw new BadRequestException(
          'Debe proporcionar al menos un campo para actualizar: archivo o coordenadas de firma',
        );
      }

      if (document.createdBy !== currentUserId) {
        throw new ForbiddenException(
          'El documento no pertenece al usuario autenticado',
        );
      }

      if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
        throw new BadRequestException(
          `El documento no puede actualizarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.CREATED}', el estatus actual es '${document.status}'`,
        );
      }

      if (fileToReplace) {
        const minioResponse = await this.minioService.replaceFile(
          document.objectKey,
          {
            file: fileToReplace,
            name: fileToReplace.originalname,
          },
          BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
        );

        if (minioResponse.status !== FILE_STATUS_ENUM.FILE_OVERWRITTEN) {
          throw new InternalServerErrorException(
            `Error al reemplazar el archivo en el almacenamiento. Estado recibido: '${minioResponse.status}'`,
          );
        }
      }

      await this.documentRepository.update(documentId, {
        signatureCoordinates: signatureCoordinatesDto,
      });

      const { secureUrl, expiresIn } = await this.minioService.getFile(
        document.objectKey,
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );

      const updatedDocument = await this.findOne(documentId);

      return {
        success: true,
        message: 'Documento actualizado exitosamente',
        data: {
          id: document.id,
          signatureCoordinates: updatedDocument.signatureCoordinates,
          secureUrl,
          expiresIn,
        },
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      )
        throw error;
      throw new Error(`Error actualizando documento: ${error}`);
    }
  }

  /** Elimina el archivo de Minio y el registro del documento. Solo permite documentos en estatus CREATED. */
  async remove(documentId: string, currentUserId: string) {
    try {
      const document = await this.findOne(documentId);

      if (document.createdBy !== currentUserId) {
        throw new ForbiddenException(
          'El documento no pertenece al usuario autenticado',
        );
      }

      if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
        throw new BadRequestException(
          'Solo es posible eliminar documentos con estatus CREATED',
        );
      }

      const response = await this.minioService.deleteFile(
        document.objectKey,
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );

      if (response.message.status !== FILE_STATUS_ENUM.FILE_DELETED) {
        throw new Error('Error eliminando archivo en Minio');
      }

      await this.documentRepository.delete({ id: documentId });
      return {
        success: true,
        message: 'Documento eliminado exitosamente',
        data: {
          id: document.id,
        },
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      )
        throw error;
      throw new Error(`Error eliminando documento: ${error}`);
    }
  }

  /** Pasa el documento a PENDING y notifica al primer firmante en turno. */
  async submitForAuthorization(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<null>> {
    const document = await this.findOne(documentId);

    if (document.createdBy !== currentUserId) {
      throw new ForbiddenException(
        'El documento no pertenece al usuario autenticado',
      );
    }

    if (document.status !== DOCUMENT_STATUS_ENUM.CREATED) {
      throw new BadRequestException(
        `El documento no puede enviarse a autorización. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.CREATED}', el estatus actual es '${document.status}'`,
      );
    }

    document.status = DOCUMENT_STATUS_ENUM.PENDING;
    await this.documentRepository.save(document);

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_SENT_TO_SIGN,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [
        { userId: currentUserId, action: AuditAction.DOCUMENT_SENT_TO_SIGN },
      ],
    });
    this.documentEventsProducer.emitSentToSign({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
    });

    try {
      await this.notifyNextSigner(documentId);
    } catch (error) {
      this.logger.error(
        `Error notificando al firmante en turno del documento ${documentId}: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Solicitud de autorización enviada exitosamente',
      data: null,
    };
  }

  /** Envía el correo de solicitud de firma al siguiente firmante pendiente en el orden establecido. */
  private async notifyNextSigner(documentId: string): Promise<void> {
    const signerCollaborators = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { user: true },
    });
    const nextSigner = getNextPendingSigner(signerCollaborators);

    if (!nextSigner) return;

    const document = await this.findOne(documentId);
    const creator = await this.userService.findOne(document.createdBy);
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';

    await this.emailService.sendDocumentPendingNotification(
      collaboratorEmail(nextSigner),
      collaboratorDisplayName(nextSigner),
      creator.email,
      document.fileName,
      `${frontendUrl}/documents/${documentId}`,
      `${frontendUrl}/documents`,
    );
  }

  /**
   * Verifica que el usuario tenga registrada y activa su firma manuscrita e identificación
   * oficial (INE) antes de permitirle firmar o rechazar un documento.
   */
  private async assertUserHasSignatureOnFile(user: UserEntity): Promise<void> {
    const missingSignatureMessage =
      'Necesitas registrar tu firma y tu identificación oficial (INE) en tu perfil antes de poder firmar o rechazar documentos';

    if (!user.signatureId) {
      throw new BadRequestException(missingSignatureMessage);
    }

    const signature = await this.signatureService
      .findOne(user.signatureId)
      .catch(() => null);

    if (
      !signature ||
      !signature.isActive ||
      !signature.signatureObjectKey ||
      !signature.officialCardObjectKey
    ) {
      throw new BadRequestException(missingSignatureMessage);
    }
  }

  /**
   * Encuentra la fila de Collaborator (SIGNER) del usuario autenticado en este documento, o
   * lanza ForbiddenException. Usado por el flujo de verificación (emitir/validar código) —
   * mismo criterio de acceso que sign()/reject().
   */
  private async findMySignerCollaborator(
    documentId: string,
    currentUserId: string,
  ): Promise<CollaboratorEntity> {
    const myParticipant = await this.collaboratorRepository.findOne({
      where: {
        documentId,
        userId: currentUserId,
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
      relations: { user: true },
    });

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    return myParticipant;
  }

  /** Emite y envía por correo un código de verificación para que el firmante autenticado pueda firmar un documento con requiresVerification=true. */
  async requestVerificationCode(
    documentId: string,
    currentUserId: string,
    ipAddress: string,
  ): Promise<BaseResponse<null>> {
    const document = await this.findOne(documentId);
    const myParticipant = await this.findMySignerCollaborator(
      documentId,
      currentUserId,
    );

    const verificationCode = await this.verificationCodeService.issue(
      documentId,
      myParticipant.id,
      VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      ipAddress,
    );

    await this.emailService.sendVerificationCodeNotification(
      collaboratorEmail(myParticipant),
      document.fileName,
      verificationCode.code,
    );

    return {
      success: true,
      message: 'Código de verificación enviado correctamente',
      data: null,
    };
  }

  /** Valida el código de verificación enviado por el firmante autenticado, consumiéndolo de un solo uso. */
  async verifyCode(
    documentId: string,
    currentUserId: string,
    code: string,
  ): Promise<BaseResponse<null>> {
    const myParticipant = await this.findMySignerCollaborator(
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

  /**
   * Registra la firma del usuario autenticado si es su turno. Si era el último firmante pendiente,
   * estampa el PDF con todas las firmas, lo mueve al bucket de firmados y notifica a todos los colaboradores.
   */
  async sign(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<{ id: string }>> {
    const document = await this.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING) {
      throw new BadRequestException(
        `El documento no puede firmarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.PENDING}', el estatus actual es '${document.status}'`,
      );
    }

    const signerCollaborators = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { user: true, simpleSignature: true },
      order: { signingOrder: 'ASC' },
    });

    const myParticipant = signerCollaborators.find(
      (c) => c.userId === currentUserId,
    );

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    if (myParticipant.status !== SIGNEE_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    if (!isSignerTurn(myParticipant, signerCollaborators)) {
      throw new ForbiddenException(
        'Aún no es tu turno para firmar este documento',
      );
    }

    await this.assertUserHasSignatureOnFile(myParticipant.user);

    // Gateo por código de verificación (ver plan de migración ER-V2, Fase 7): opt-in por
    // documento vía requiresVerification (default false) — si está apagado, el flujo de firma
    // sigue exactamente igual que siempre, sin ningún riesgo para el caso dominante.
    if (document.requiresVerification) {
      const hasVerified = await this.verificationCodeService.hasConsumedCode(
        documentId,
        myParticipant.id,
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      );
      if (!hasVerified) {
        throw new BadRequestException(
          'Este documento requiere verificación. Solicita y valida tu código antes de firmar.',
        );
      }
    }

    const remainingSigners = signerCollaborators.filter(
      (c) => c.id !== myParticipant.id && c.status === SIGNEE_STATUS_ENUM.PENDING,
    );

    // Si soy el último firmante pendiente, estampo y finalizo el documento ANTES de
    // registrar mi firma: si el estampado falla, ni el colaborador ni el documento
    // quedan marcados como firmados, y la firma puede reintentarse sin quedar atascada.
    document.completedSignersCount = (document.completedSignersCount ?? 0) + 1;

    if (remainingSigners.length === 0) {
      // finalizeSignedDocument guarda `document` (ya con completedSignersCount incrementado).
      await this.finalizeSignedDocument(document, signerCollaborators);
      this.documentEventsProducer.emitSigned({
        documentId,
        fileName: document.fileName,
        actorUserId: currentUserId,
      });
    } else {
      await this.documentRepository.update(documentId, {
        completedSignersCount: document.completedSignersCount,
      });
    }

    myParticipant.status = SIGNEE_STATUS_ENUM.SIGNED;
    myParticipant.signedAt = new Date();
    await this.collaboratorRepository.save(myParticipant);

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_SIGNED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [{ userId: currentUserId, action: AuditAction.DOCUMENT_SIGNED }],
      signedAt: myParticipant.signedAt,
    });

    if (remainingSigners.length > 0) {
      try {
        await this.notifyNextSigner(documentId);
      } catch (error) {
        this.logger.error(
          `Error notificando al siguiente firmante del documento ${documentId}: ${error}`,
        );
      }
      return {
        success: true,
        message:
          'Firma registrada correctamente. Se notificó al siguiente firmante.',
        data: { id: documentId },
      };
    }

    return {
      success: true,
      message: 'Documento firmado exitosamente por todos los firmantes',
      data: { id: documentId },
    };
  }

  /** Estampa las firmas de todos los firmantes (apiladas), mueve el archivo a firmados y notifica a todos los colaboradores. */
  private async finalizeSignedDocument(
    document: DocumentEntity,
    signerCollaborators: CollaboratorEntity[],
  ): Promise<void> {
    try {
      let documentBuffer = await this.minioService.getFileInBytesFormat(
        document.objectKey,
        BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
      );

      const baseCoordinates: SignatureCoordinates =
        document.signatureCoordinates ?? DEFAULT_COORDINATES;
      const verticalStep =
        baseCoordinates.height + SIGNATURE_STAMP_VERTICAL_GAP;

      // Coordenadas por colaborador (ver Fase 4 del plan de migración ER-V2): quien tiene
      // simpleSignature explícita se estampa ahí; el resto se apila automáticamente desde el
      // ancla del documento, exactamente como antes — el índice de apilado solo avanza para
      // los colaboradores SIN coordenadas explícitas, para que no colisionen entre sí.
      let autoStackIndex = 0;
      for (const collaborator of signerCollaborators) {
        // Los firmantes siempre tienen cuenta de plataforma (userId no-nulo): solo watchers
        // y reviewers pueden invitarse por email únicamente (ver create()).
        const signerUser =
          collaborator.user ??
          (await this.userService.findOne(collaborator.userId as string));
        const signature = await this.signatureService.findOne(
          signerUser.signatureId,
        );
        const signatureBuffer = await this.minioService.getFileInBytesFormat(
          signature.signatureObjectKey,
          BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
        );

        let coordinates: SignatureCoordinates;
        if (collaborator.simpleSignature) {
          coordinates = collaborator.simpleSignature.signatureCoordinates;
        } else {
          coordinates = {
            ...baseCoordinates,
            y: baseCoordinates.y + autoStackIndex * verticalStep,
          };
          autoStackIndex += 1;
        }

        documentBuffer =
          await this.documentSigningSerivice.mergeSignatureIntoPdf(
            documentBuffer,
            signatureBuffer,
            coordinates,
          );

        documentBuffer = await this.documentSigningSerivice.addSignerName(
          documentBuffer,
          `${signerUser.firstName} ${signerUser.lastName}`,
          coordinates,
        );
      }

      const signerNames = signerCollaborators
        .map(collaboratorDisplayName)
        .join(', ');

      await this.minioService.uploadPdfAObject(
        {
          file: documentBuffer,
          name: document.fileName,
          mimetype: 'application/pdf',
        },
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        signerNames,
        document.objectKey,
      );

      document.signedHash =
        await this.hashService.generateFileHash(documentBuffer);
      document.signedAt = new Date();
      document.status = DOCUMENT_STATUS_ENUM.SIGNED;
      await this.documentRepository.save(document);
    } catch (error) {
      this.logger.error(`Error estampando documento: ${error}`);
      throw new Error(`Error estampando el documento: ${error}`);
    }

    try {
      await this.sendCompletionEmails(document.id);
    } catch (error) {
      this.logger.error(
        `Error enviando correos de finalización del documento ${document.id}: ${error}`,
      );
    }
  }

  /** Envía el PDF final firmado por correo a todos los colaboradores (firmantes, watchers y reviewers). */
  private async sendCompletionEmails(documentId: string): Promise<void> {
    const document = await this.findOne(documentId);
    const collaborators = await this.collaboratorRepository.find({
      where: { documentId },
      relations: { user: true },
    });

    const signedBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
    );

    await Promise.all(
      collaborators.map((collaborator) =>
        this.emailService.sendDocumentSignedNotification(
          collaboratorEmail(collaborator),
          collaboratorDisplayName(collaborator),
          document.fileName,
          signedBuffer,
        ),
      ),
    );
  }

  /** Rechaza el documento a nombre del firmante autenticado (si es su turno) y notifica al creador con el motivo. */
  async reject(
    documentId: string,
    currentUserId: string,
    reason: string,
  ): Promise<BaseResponse<{ id: string }>> {
    const document = await this.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING) {
      throw new BadRequestException(
        `El documento no puede rechazarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.PENDING}', el estatus actual es '${document.status}'`,
      );
    }

    const signerCollaborators = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { user: true },
      order: { signingOrder: 'ASC' },
    });

    const myParticipant = signerCollaborators.find(
      (c) => c.userId === currentUserId,
    );

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    if (myParticipant.status !== SIGNEE_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    if (!isSignerTurn(myParticipant, signerCollaborators)) {
      throw new ForbiddenException(
        'Aún no es tu turno para revisar este documento',
      );
    }

    await this.assertUserHasSignatureOnFile(myParticipant.user);

    // Estampo y muevo el documento a rechazados ANTES de marcar al colaborador como
    // rechazado: si el estampado o la subida a MinIO fallan, ni el colaborador ni el
    // documento quedan marcados, y el rechazo puede reintentarse sin quedar atascado.
    const documentBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    );
    const rejectedDocument =
      await this.documentSigningSerivice.stampRejectedWatermark(documentBuffer);

    if (!rejectedDocument) {
      throw new Error('El servicio de rechazo no retornó un documento válido');
    }

    await this.minioService.uploadObject(
      {
        file: rejectedDocument,
        name: document.fileName,
        mimetype: 'application/pdf',
      },
      BUCKET_TYPES_ENUM.REJECTED_DOCUMENTS,
      document.objectKey,
    );

    document.rejectedAt = new Date();
    document.status = DOCUMENT_STATUS_ENUM.REJECTED;
    await this.documentRepository.save(document);

    myParticipant.status = SIGNEE_STATUS_ENUM.REJECTED;
    myParticipant.cancellationReason = reason;
    await this.collaboratorRepository.save(myParticipant);

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_REJECTED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [{ userId: currentUserId, action: AuditAction.DOCUMENT_REJECTED }],
    });
    this.documentEventsProducer.emitRejected({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
    });

    const creator = await this.userService.findOne(document.createdBy);
    try {
      await this.emailService.sendDocumentRejectedNotification(
        creator.email,
        `${creator.firstName} ${creator.lastName}`,
        collaboratorDisplayName(myParticipant),
        document.fileName,
        reason,
      );
    } catch (error) {
      this.logger.error(
        `Error notificando el rechazo del documento ${documentId}: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Documento rechazado correctamente',
      data: { id: documentId },
    };
  }

  /**
   * Pasa un documento ya firmado a estatus CANCELLATION_PENDING y notifica a los firmantes.
   * Solo el creador puede solicitarlo.
   */
  async requestCancellation(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<null>> {
    const document = await this.findOne(documentId);

    if (document.createdBy !== currentUserId) {
      throw new ForbiddenException(
        'El documento no pertenece al usuario autenticado',
      );
    }

    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      throw new BadRequestException(
        `El documento no puede enviarse a cancelación. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.SIGNED}', el estatus actual es '${document.status}'`,
      );
    }

    const signerCollaborators = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations: { user: true },
    });

    document.status = DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING;
    await this.documentRepository.save(document);

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_CANCELLATION_REQUESTED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [
        {
          userId: currentUserId,
          action: AuditAction.DOCUMENT_CANCELLATION_REQUESTED,
        },
      ],
    });
    this.documentEventsProducer.emitCancellationRequested({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
    });

    try {
      await Promise.all(
        signerCollaborators.map((collaborator) =>
          this.emailService.sendDocumentCancellationPendingNotification(
            collaboratorEmail(collaborator),
            document.fileName,
            collaboratorDisplayName(collaborator),
          ),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Error notificando la solicitud de cancelación del documento ${documentId}: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Solicitud de cancelación enviada exitosamente',
      data: null,
    };
  }

  /**
   * Confirma la cancelación de un documento: cualquier firmante puede aprobarla (basta una
   * confirmación, igual que el rechazo). Estampa "CANCELADO", mueve el archivo a cancelados y
   * notifica a todos los colaboradores.
   */
  async confirmCancellation(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<{ id: string }>> {
    const document = await this.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING) {
      throw new BadRequestException(
        `El documento no puede cancelarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING}', el estatus actual es '${document.status}'`,
      );
    }

    const collaborators = await this.collaboratorRepository.find({
      where: { documentId },
      relations: { user: true },
    });

    const isSigner = collaborators.some(
      (c) =>
        c.userId === currentUserId &&
        c.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER,
    );
    if (!isSigner) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    const documentBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
    );
    const cancelledDocument =
      await this.documentSigningSerivice.stampCancelledWatermark(
        documentBuffer,
      );

    await this.minioService.uploadObject(
      {
        file: cancelledDocument,
        name: document.fileName,
        mimetype: 'application/pdf',
      },
      BUCKET_TYPES_ENUM.CANCELLED_DOCUMENTS,
      document.objectKey,
    );

    document.cancelledAt = new Date();
    document.status = DOCUMENT_STATUS_ENUM.CANCELLED;
    await this.documentRepository.save(document);

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_CANCELLED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [
        { userId: currentUserId, action: AuditAction.DOCUMENT_CANCELLED },
      ],
    });
    this.documentEventsProducer.emitCancelled({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
    });

    try {
      await Promise.all(
        collaborators.map((collaborator) =>
          this.emailService.sendDocumentCancelledNotification(
            collaboratorEmail(collaborator),
            collaboratorDisplayName(collaborator),
            document.fileName,
          ),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Error notificando la cancelación del documento ${documentId}: ${error}`,
      );
    }

    return {
      success: true,
      message: 'Documento cancelado exitosamente',
      data: { id: documentId },
    };
  }
}
