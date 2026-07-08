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
import { Repository } from 'typeorm';

// Entities
import { DocumentEntity } from './entities/document.entity';
import { DocumentParticipantEntity } from './entities/document-participant.entity';

// DTOs
import { CreateDocumentDto } from './dto/create-document.dto';

// Enums
import { DOCUMENT_STATUS_ENUM } from './enum/document-status.enum';
import { DOCUMENT_PARTICIPANT_ROLE_ENUM } from './enum/document-participant-role.enum';
import { DOCUMENT_PARTICIPANT_STATUS_ENUM } from './enum/document-participant-status.enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';

// Interfaces & payloads
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DEFAULT_COORDINATES } from 'src/shared/document-signing/interfaces/default-signing-coordinates.interface';
import { SignatureCoordinates } from './interfaces/signature-coordinates';

// Services
import { MinioService } from '../shared/minio/minio.service';
import { HashService } from '../shared/hash/hash.service';
import { UserService } from '../user/user.service';
import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
import { SignatureService } from 'src/signature/signature.service';
import { EmailService } from 'src/shared/email/email.service';
import { AuditService } from 'src/audit/audit.service';
import { AuditAction } from 'src/audit/schema/audit-document';
import { GetDocumentsQueryDto } from './dto/get-documents-query.dto';
import { SignatureCoordinatesDto } from './dto/signature-coordinates.dto';
import { UpdateDocumentData } from './interfaces/responses/document-update-response';

const SIGNATURE_STAMP_VERTICAL_GAP = 40;

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
    @InjectRepository(DocumentParticipantEntity)
    private readonly participantRepository: Repository<DocumentParticipantEntity>,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly userService: UserService,
    private readonly documentSigningSerivice: PdfSignatureService,
    private readonly signatureService: SignatureService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
  ) {}

  /** Sube el archivo a Minio, genera su hash y registra el documento y sus participantes (firmantes/espectadores) en la base de datos. */
  async create(
    createdBy: string,
    createDocumentDto: CreateDocumentDto,
    file: Express.Multer.File,
    ip: string,
  ): Promise<BaseResponse> {
    try {
      if (!file) {
        throw new BadRequestException('Archivo no proporcionado');
      }

      const { signerIds, spectatorIds, signatureCoordinates } =
        createDocumentDto;

      await Promise.all(
        [...signerIds, ...(spectatorIds ?? [])].map((userId) =>
          this.userService.findOne(userId),
        ),
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
      });

      const savedDocument = await this.documentRepository.save(document);

      const participants = [
        ...signerIds.map((userId, index) =>
          this.participantRepository.create({
            documentId: savedDocument.id,
            userId,
            role: DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER,
            signOrder: index,
          }),
        ),
        ...(spectatorIds ?? []).map((userId) =>
          this.participantRepository.create({
            documentId: savedDocument.id,
            userId,
            role: DOCUMENT_PARTICIPANT_ROLE_ENUM.SPECTATOR,
          }),
        ),
      ];

      await this.participantRepository.save(participants);

      const url = await this.getDocumentMinioURL(savedDocument.id);
      const { signers, spectators } = await this.getParticipantNames(
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
          spectators,
          creator: `${requestedBy.firstName} ${requestedBy.lastName}`,
          status: savedDocument.status,
          secureUrl: url.secureUrl,
          expiresIn: url.expiresIn,
        },
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      )
        throw error;
      throw new Error(`Error creando documento para firma: ${error}`);
    }
  }

  private async getParticipantNames(
    documentId: string,
  ): Promise<{ signers: string[]; spectators: string[] }> {
    const participants = await this.participantRepository.find({
      where: { documentId },
      relations: { user: true },
      order: { signOrder: 'ASC' },
    });

    return {
      signers: participants
        .filter((p) => p.role === DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER)
        .map((p) => `${p.user.firstName} ${p.user.lastName}`),
      spectators: participants
        .filter((p) => p.role === DOCUMENT_PARTICIPANT_ROLE_ENUM.SPECTATOR)
        .map((p) => `${p.user.firstName} ${p.user.lastName}`),
    };
  }

  async findWithFilters(query: GetDocumentsQueryDto) {
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

    const qb = this.documentRepository
      .createQueryBuilder('document')
      .leftJoinAndSelect('document.requestedBy', 'requester')
      .leftJoinAndSelect('document.participants', 'participant')
      .leftJoinAndSelect('participant.user', 'participantUser')
      .orderBy('document.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (id) {
      qb.andWhere('document.id = :id', { id });
    }

    if (participantEmail) {
      qb.andWhere(
        'document.id IN (SELECT dp.document_id FROM document_participants dp INNER JOIN users u ON u.id = dp.user_id WHERE u.email = :participantEmail)',
        { participantEmail },
      );
    }

    if (email) {
      qb.andWhere(
        '(requester.email = :email OR document.id IN (SELECT dp.document_id FROM document_participants dp INNER JOIN users u ON u.id = dp.user_id WHERE u.email = :email))',
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
          SELECT dp.document_id FROM document_participants dp
          INNER JOIN users u ON u.id = dp.user_id
          WHERE u.first_name ILIKE :participantName
             OR u.last_name ILIKE :participantName
             OR u.email ILIKE :participantName
        )`,
        { participantName: `%${participantName}%` },
      );
    }

    if (myTurnOnly && participantEmail) {
      qb.andWhere(
        `document.id IN (
          SELECT dp.document_id FROM document_participants dp
          INNER JOIN users u ON u.id = dp.user_id
          WHERE u.email = :participantEmail
            AND dp.role = 'signer'
            AND dp.status = 'pending'
            AND dp.sign_order = (
              SELECT MIN(dp2.sign_order) FROM document_participants dp2
              WHERE dp2.document_id = dp.document_id
                AND dp2.role = 'signer'
                AND dp2.status = 'pending'
            )
        )`,
        { participantEmail },
      );
    }

    const [documents, total] = await qb.getManyAndCount();

    const data = await Promise.all(
      documents.map(async (doc) => {
        const signers = (doc.participants ?? [])
          .filter((p) => p.role === DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER)
          .sort((a, b) => a.signOrder - b.signOrder)
          .map((p) => `${p.user.firstName} ${p.user.lastName}`);
        const spectators = (doc.participants ?? [])
          .filter((p) => p.role === DOCUMENT_PARTICIPANT_ROLE_ENUM.SPECTATOR)
          .map((p) => `${p.user.firstName} ${p.user.lastName}`);

        const base = {
          id: doc.id,
          fileName: doc.fileName,
          fileType: doc.fileType,
          signers,
          spectators,
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
      relations: { requestedBy: true, participants: { user: true } },
    });

    if (!document) {
      throw new NotFoundException(
        `El documento con id ${documentId} no se encuentra`,
      );
    }

    const isCreator = document.createdBy === currentUserId;
    const myParticipant = document.participants.find(
      (p) => p.userId === currentUserId,
    );

    if (!isCreator && !myParticipant) {
      throw new ForbiddenException('No tienes acceso a este documento');
    }

    const signerParticipants = document.participants
      .filter((p) => p.role === DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER)
      .sort((a, b) => a.signOrder - b.signOrder);

    const nextSigner = signerParticipants.find(
      (p) => p.status === DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING,
    );

    const isMyTurn = Boolean(
      myParticipant &&
      myParticipant.role === DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER &&
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
      myParticipant?.status === DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING;

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
        participants: document.participants
          .sort((a, b) => a.signOrder - b.signOrder)
          .map((p) => ({
            userId: p.userId,
            name: `${p.user.firstName} ${p.user.lastName}`,
            role: p.role,
            status: p.status,
            rejectionReason: p.rejectionReason,
          })),
        myRole: myParticipant?.role ?? (isCreator ? 'creator' : null),
        myStatus: myParticipant?.status ?? null,
        canSign: canAct,
        canReject: canAct,
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

  /** Verifica si el usuario tiene acceso al documento (creador o participante). Usado para proteger la descarga del archivo. */
  async assertUserHasAccess(
    documentId: string,
    userId: string,
  ): Promise<DocumentEntity> {
    const document = await this.findOne(documentId);
    if (document.createdBy === userId) {
      return document;
    }
    const participant = await this.participantRepository.findOne({
      where: { documentId, userId },
    });
    if (!participant) {
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

    await this.notifyNextSigner(documentId);

    return {
      success: true,
      message: 'Solicitud de autorización enviada exitosamente',
      data: null,
    };
  }

  /** Envía el correo de solicitud de firma al siguiente firmante pendiente en el orden establecido. */
  private async notifyNextSigner(documentId: string): Promise<void> {
    const nextSigner = await this.participantRepository.findOne({
      where: {
        documentId,
        role: DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER,
        status: DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING,
      },
      order: { signOrder: 'ASC' },
      relations: { user: true },
    });

    if (!nextSigner) return;

    const document = await this.findOne(documentId);
    const creator = await this.userService.findOne(document.createdBy);
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';

    await this.emailService.sendDocumentPendingNotification(
      nextSigner.user.email,
      `${nextSigner.user.firstName} ${nextSigner.user.lastName}`,
      creator.email,
      document.fileName,
      `${frontendUrl}/documents/${documentId}`,
      `${frontendUrl}/documents`,
    );
  }

  /**
   * Registra la firma del usuario autenticado si es su turno. Si era el último firmante pendiente,
   * estampa el PDF con todas las firmas, lo mueve al bucket de firmados y notifica a todos los participantes.
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

    const signerParticipants = await this.participantRepository.find({
      where: { documentId, role: DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER },
      relations: { user: true },
      order: { signOrder: 'ASC' },
    });

    const myParticipant = signerParticipants.find(
      (p) => p.userId === currentUserId,
    );

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    if (myParticipant.status !== DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    const pendingBeforeMe = signerParticipants.some(
      (p) =>
        p.signOrder < myParticipant.signOrder &&
        p.status === DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING,
    );

    if (pendingBeforeMe) {
      throw new ForbiddenException(
        'Aún no es tu turno para firmar este documento',
      );
    }

    myParticipant.status = DOCUMENT_PARTICIPANT_STATUS_ENUM.SIGNED;
    myParticipant.signedAt = new Date();
    await this.participantRepository.save(myParticipant);

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_SIGNED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [{ userId: currentUserId, action: AuditAction.DOCUMENT_SIGNED }],
      signedAt: myParticipant.signedAt,
    });

    const remainingSigners = signerParticipants.filter(
      (p) =>
        p.id !== myParticipant.id &&
        p.status === DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING,
    );

    if (remainingSigners.length > 0) {
      await this.notifyNextSigner(documentId);
      return {
        success: true,
        message:
          'Firma registrada correctamente. Se notificó al siguiente firmante.',
        data: { id: documentId },
      };
    }

    await this.finalizeSignedDocument(document, signerParticipants);

    return {
      success: true,
      message: 'Documento firmado exitosamente por todos los firmantes',
      data: { id: documentId },
    };
  }

  /** Estampa las firmas de todos los firmantes (apiladas), mueve el archivo a firmados y notifica a todos los participantes. */
  private async finalizeSignedDocument(
    document: DocumentEntity,
    signerParticipants: DocumentParticipantEntity[],
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

      for (const [index, participant] of signerParticipants.entries()) {
        const signerUser =
          participant.user ??
          (await this.userService.findOne(participant.userId));
        const signature = await this.signatureService.findOne(
          signerUser.signatureId,
        );
        const signatureBuffer = await this.minioService.getFileInBytesFormat(
          signature.signatureObjectKey,
          BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
        );

        const coordinates: SignatureCoordinates = {
          ...baseCoordinates,
          y: baseCoordinates.y + index * verticalStep,
        };

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

      const signerNames = signerParticipants
        .map((p) => `${p.user.firstName} ${p.user.lastName}`)
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

      await this.sendCompletionEmails(document.id);
    } catch (error) {
      this.logger.error(`Error estampando documento: ${error}`);
      throw new Error(`Error estampando el documento: ${error}`);
    }
  }

  /** Envía el PDF final firmado por correo a todos los participantes (firmantes y espectadores). */
  private async sendCompletionEmails(documentId: string): Promise<void> {
    const document = await this.findOne(documentId);
    const participants = await this.participantRepository.find({
      where: { documentId },
      relations: { user: true },
    });

    const signedBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
    );

    await Promise.all(
      participants.map((participant) =>
        this.emailService.sendDocumentSignedNotification(
          participant.user.email,
          `${participant.user.firstName} ${participant.user.lastName}`,
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

    const signerParticipants = await this.participantRepository.find({
      where: { documentId, role: DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER },
      relations: { user: true },
      order: { signOrder: 'ASC' },
    });

    const myParticipant = signerParticipants.find(
      (p) => p.userId === currentUserId,
    );

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    if (myParticipant.status !== DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    const pendingBeforeMe = signerParticipants.some(
      (p) =>
        p.signOrder < myParticipant.signOrder &&
        p.status === DOCUMENT_PARTICIPANT_STATUS_ENUM.PENDING,
    );

    if (pendingBeforeMe) {
      throw new ForbiddenException(
        'Aún no es tu turno para revisar este documento',
      );
    }

    myParticipant.status = DOCUMENT_PARTICIPANT_STATUS_ENUM.REJECTED;
    myParticipant.rejectedAt = new Date();
    myParticipant.rejectionReason = reason;
    await this.participantRepository.save(myParticipant);

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

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_REJECTED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [{ userId: currentUserId, action: AuditAction.DOCUMENT_REJECTED }],
    });

    const creator = await this.userService.findOne(document.createdBy);
    await this.emailService.sendDocumentRejectedNotification(
      creator.email,
      `${creator.firstName} ${creator.lastName}`,
      `${myParticipant.user.firstName} ${myParticipant.user.lastName}`,
      document.fileName,
      reason,
    );

    return {
      success: true,
      message: 'Documento rechazado correctamente',
      data: { id: documentId },
    };
  }

  /** Pasa un documento ya firmado a estatus CANCELLATION_PENDING y notifica a los firmantes. */
  async requestCancellation(documentId: string): Promise<BaseResponse<null>> {
    const document = await this.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      throw new BadRequestException(
        `El documento no puede enviarse a cancelación. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.SIGNED}', el estatus actual es '${document.status}'`,
      );
    }

    const signerParticipants = await this.participantRepository.find({
      where: { documentId, role: DOCUMENT_PARTICIPANT_ROLE_ENUM.SIGNER },
      relations: { user: true },
    });

    document.status = DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING;
    await this.documentRepository.save(document);

    await Promise.all(
      signerParticipants.map((participant) =>
        this.emailService.sendDocumentCancellationPendingNotification(
          participant.user.email,
          document.fileName,
          `${participant.user.firstName} ${participant.user.lastName}`,
        ),
      ),
    );

    return {
      success: true,
      message: 'Solicitud de cancelación enviada exitosamente',
      data: null,
    };
  }
}
