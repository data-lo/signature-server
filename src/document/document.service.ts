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
import { FindOptionsRelations, ILike, In, IsNull, Repository } from 'typeorm';

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
import { SIGNATURE_TYPE_ENUM } from './enum/signature-type.enum';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { FILE_STATUS_ENUM } from 'src/shared/minio/enums/file-status-enum';

// Interfaces & payloads
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DEFAULT_COORDINATES } from 'src/shared/document-signing/interfaces/default-signing-coordinates.interface';
import { SignatureCoordinates } from 'src/shared/document-signing/interfaces/signature-coordinates.interface';
import type {
  LegacySignatureCoordinates,
  SignaturePositionRecord,
} from 'src/signature/entities/simple-signature.entity';

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
import { GeolocationDto } from './dto/sign-document.dto';
import { UpdateDocumentData } from './interfaces/responses/document-update-response';
import { DocumentPublicViewResponse } from './interfaces/responses/document-public-view-response';
import { AccountMemberService } from 'src/account/account-member.service';
import { getNextPendingSigner, isSignerTurn } from './utils/next-signer.util';
import {
  collaboratorDisplayName,
  collaboratorEmail,
} from './utils/collaborator-display.util';
import {
  buildAllDocumentsUrl,
  buildDocumentAccessUrl,
} from './utils/document-access-url.util';
import { VerificationCodeService } from './verification-code.service';
import { VERIFICATION_EVENT_ENUM } from './enum/verification-event.enum';
import {
  MAX_PDF_FILE_SIZE_BYTES,
  MAX_EFIRMA_FILE_SIZE_BYTES,
} from 'src/shared/constants/file-upload.constants';
import { DocumentTransactionService } from './document-transaction.service';
import { EfirmaService } from 'src/efirma/efirma.service';
import type { SignatureResult } from 'src/efirma/interfaces/signature-result.interface';
import { SealDocumentUseCase } from './seal/use-cases/seal-document.use-case';
import type { SealDocumentDto } from './seal/dto/seal-document.dto';

const SIGNATURE_STAMP_VERTICAL_GAP = 40;

/** .key/.cer suben por separado como multipart (no forman parte de SignDocumentDto). */
interface AdvancedSignatureInput {
  password?: string;
  keyFile?: Express.Multer.File;
  cerFile?: Express.Multer.File;
}

/**
 * Distingue una posición en el shape nuevo (ratios 0-1, ver historia "Ubicación de firmas por
 * usuario") de una en el shape legacy (píxeles absolutos, pre-migración
 * `ArraySignatureCoordinates`) dentro del mismo arreglo `signatureCoordinates`.
 */
function isRatioSignaturePosition(
  position: SignaturePositionRecord | LegacySignatureCoordinates,
): position is SignaturePositionRecord {
  return 'xRatio' in position;
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
    private readonly documentTransactionService: DocumentTransactionService,
    private readonly efirmaService: EfirmaService,
    private readonly sealDocumentUseCase: SealDocumentUseCase,
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
      const activeAccount =
        await this.accountMemberService.assertIsActiveMember(
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

      // Los collaborators anclan a la cuenta PERSONAL del invitado, no a su userId crudo (ver
      // docblock de CollaboratorEntity.accountId) — se resuelve una sola vez por participante
      // aquí, antes de crear las filas.
      const accountIdByUserId = new Map<string, string>(
        await Promise.all(
          [...uniqueParticipantIds].map(
            async (userId) =>
              [
                userId,
                await this.accountMemberService.findPersonalAccountId(userId),
              ] as const,
          ),
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
        accountId,
        // Clave real de aislamiento multi-tenant para contexto de organización (ver plan de
        // migración ER-V2, Fase 5, decisión D5): accountId ahora es una fila por usuario, así
        // que ya no agrupa a todos los miembros de una misma organización. organizationId sí.
        organizationId: activeAccount.organizationId,
        totalSigners: signerIds.length,
      });

      const savedDocument = await this.documentRepository.save(document);

      await this.documentTransactionService.createInitial(
        savedDocument.id,
        hashBefore,
      );

      const collaborators = [
        ...signerIds.map((userId, index) =>
          this.collaboratorRepository.create({
            documentId: savedDocument.id,
            accountId: accountIdByUserId.get(userId),
            colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
            signingOrder: index,
            ipAddress: ip,
          }),
        ),
        ...(watcherIds ?? []).map((userId) =>
          this.collaboratorRepository.create({
            documentId: savedDocument.id,
            accountId: accountIdByUserId.get(userId),
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
            accountId: accountIdByUserId.get(userId),
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
      relations: { account: { user: true } },
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

    const qb = this.documentRepository
      .createQueryBuilder('document')
      .leftJoinAndSelect('document.requestedBy', 'requester')
      .leftJoinAndSelect('document.collaborators', 'collaborator')
      .leftJoinAndSelect('collaborator.account', 'collaboratorAccount')
      .leftJoinAndSelect('collaboratorAccount.user', 'collaboratorUser')
      .orderBy('document.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (!participantEmail) {
      qb.andWhere(
        activeAccount.organizationId
          ? 'document.organizationId = :organizationId'
          : 'document.accountId = :accountId',
        activeAccount.organizationId
          ? { organizationId: activeAccount.organizationId }
          : { accountId },
      );
    }

    if (id) {
      qb.andWhere('document.id = :id', { id });
    }

    if (participantEmail) {
      qb.andWhere(
        `document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN accounts a ON a.id = c.account_id
          LEFT JOIN users u ON u.id = a.user_id
          WHERE u.email = :participantEmail OR c.email = :participantEmail
        )`,
        { participantEmail },
      );
    }

    if (email) {
      qb.andWhere(
        `(requester.email = :email OR document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN accounts a ON a.id = c.account_id
          LEFT JOIN users u ON u.id = a.user_id
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
          LEFT JOIN accounts a ON a.id = c.account_id
          LEFT JOIN users u ON u.id = a.user_id
          WHERE u.first_name ILIKE :participantName
             OR u.last_name ILIKE :participantName
             OR u.email ILIKE :participantName
             OR c.email ILIKE :participantName
        )`,
        { participantName: `%${participantName}%` },
      );
    }

    if (myTurnOnly && participantEmail) {
      // LEFT JOIN a propósito (antes INNER): un colaborador invitado solo por email todavía no
      // tiene account_id (ver DocumentSignaturesService.create(), accountId siempre null al
      // crear), así que el INNER JOIN lo excluía de "me toca firmar" hasta que alguien completara
      // la vinculación perezosa de cuenta — que hoy en día solo ocurre al firmar/rechazar/pedir
      // el código, es decir, nunca antes de ver esta misma lista.
      qb.andWhere(
        `document.id IN (
          SELECT c.document_id FROM collaborators c
          LEFT JOIN accounts a ON a.id = c.account_id
          LEFT JOIN users u ON u.id = a.user_id
          WHERE (u.email = :participantEmail OR c.email = :participantEmail)
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

  /**
   * Colaborador que corresponde al usuario autenticado dentro de un documento, para operaciones
   * de LECTURA.
   *
   * Se resuelve primero por cuenta vinculada y, si no hay, por email (case-insensitive) contra
   * las invitaciones que todavía no tienen `accountId`.
   *
   * Bug corregido: solo se emparejaba por `accountId`, pero ese campo permanece en null hasta que
   * el firmante entra por el enlace del correo (`/access-document` → linkPendingCollaboratorAccount).
   * Como el listado (`GET /document?participantEmail=`) sí filtra por email, el usuario veía en
   * "Por firmar" documentos que el detalle le rechazaba con 403 — quedaba atascado si llegaba por
   * la navegación en vez del correo. Emparejar por email aquí no amplía el modelo de seguridad:
   * `sign()`/`reject()` ya identifican al firmante exactamente así (ver
   * findOrLinkMySignerCollaborator), y el email de la cuenta está verificado por OTP en el
   * registro.
   *
   * Sigue sin vincular nada (ver historia "Vinculación del documento debe postergarse hasta el
   * inicio de sesión y validación de RFC"): una lectura no puede tener el efecto secundario de
   * asociar la cuenta: eso sigue siendo una acción explícita de AccessDocumentView/useLogin, o
   * perezosa dentro de sign()/reject().
   */
  private async resolveMyCollaborator(
    collaborators: CollaboratorEntity[],
    currentUserId: string,
  ): Promise<CollaboratorEntity | undefined> {
    const linked = collaborators.find(
      (c) => c.account?.userId === currentUserId,
    );
    if (linked) {
      return linked;
    }

    const pendingInvitations = collaborators.filter((c) => !c.accountId);
    if (pendingInvitations.length === 0) {
      return undefined;
    }

    const user = await this.userService.findOne(currentUserId);
    const userEmail = user.email?.toLowerCase();

    return pendingInvitations.find(
      (c) => Boolean(c.email) && c.email!.toLowerCase() === userEmail,
    );
  }

  /** Obtiene el detalle de un documento para la pantalla de firma, incluyendo el rol/turno del usuario autenticado. */
  async findDetailForUser(documentId: string, currentUserId: string) {
    const documentDetailRelations: FindOptionsRelations<DocumentEntity> = {
      requestedBy: true,
      collaborators: { account: { user: true } },
    };

    const document = await this.documentRepository.findOne({
      where: { id: documentId },
      relations: documentDetailRelations,
    });

    if (!document) {
      throw new NotFoundException(
        `El documento con id ${documentId} no se encuentra`,
      );
    }

    const isCreator = document.createdBy === currentUserId;
    const myParticipant = await this.resolveMyCollaborator(
      document.collaborators,
      currentUserId,
    );

    if (!isCreator && !myParticipant) {
      throw new ForbiddenException('No tienes acceso a este documento');
    }

    const isMyTurn = Boolean(
      myParticipant &&
      myParticipant.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER &&
      isSignerTurn(
        myParticipant,
        document.collaborators,
        document.isSequential,
      ),
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

    // Registro de Transacciones (Document Transaction): además del registro inicial de creación
    // (collaboratorId null), hay un registro por cada firma SIMPLE; las firmas avanzadas no
    // encadenan uno propio y el documento se cierra con un registro final, también sin
    // collaboratorId — ver DocumentTransactionService. Por eso un firmante FIEL expone
    // actualHash/chainHash en null: su evidencia vive en CollaboratorEntity.advancedSignature.
    const transactions =
      await this.documentTransactionService.findAllForDocument(documentId);
    const transactionByCollaboratorId = new Map(
      transactions
        .filter((t) => t.collaboratorId)
        .map((t) => [t.collaboratorId as string, t]),
    );

    // Bug corregido: esta vista no exponía si el documento exige 2FA (requiresVerification) ni si
    // este firmante ya lo pasó — el frontend no tenía forma de saber que debía pedir/validar un
    // código antes de firmar, así que el único botón ("Continuar a firmar") llamaba sign()
    // directo y siempre fallaba con 400 para documentos de Firma Simple (que lo exigen siempre).
    const requiresVerification =
      document.requiresVerification &&
      myParticipant?.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER;
    const verificationConfirmed = requiresVerification
      ? await this.verificationCodeService.hasConsumedCode(
          documentId,
          myParticipant!.id,
          VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
        )
      : false;

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
            userId: c.account?.userId ?? null,
            email: collaboratorEmail(c),
            name: collaboratorDisplayName(c),
            role: c.colaboratorType,
            status: c.status,
            cancellationReason: c.cancellationReason,
          })),
        myRole:
          myParticipant?.colaboratorType ?? (isCreator ? 'creator' : null),
        myStatus: myParticipant?.status ?? null,
        mySignatureType: myParticipant?.signatureType ?? null,
        canSign: canAct,
        canReject: canAct,
        canRequestCancellation,
        canConfirmCancellation,
        requiresVerification: Boolean(requiresVerification),
        verificationConfirmed,
        // Avance de firmas en tiempo real (ver Registro de Transacciones / Document
        // Transaction): completedSignersCount se compara contra totalSigners para saber si al
        // documento le falta algún firmante. completedSignedAt es la fecha en la que se
        // completó la última firma (document.signedAt solo se fija cuando el documento pasa a
        // SIGNED, ver finalizeSignedDocument()).
        totalSigners: document.totalSigners,
        completedSignersCount: document.completedSignersCount,
        completedSignedAt: document.signedAt ?? null,
        signatures: document.collaborators
          .filter((c) => c.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER)
          .sort((a, b) => (a.signingOrder ?? 0) - (b.signingOrder ?? 0))
          .map((c) => {
            const transaction = transactionByCollaboratorId.get(c.id);
            return {
              collaboratorId: c.id,
              name: collaboratorDisplayName(c),
              email: collaboratorEmail(c),
              status: c.status,
              signedAt: c.signedAt,
              actualHash: transaction?.actualHash ?? null,
              chainHash: transaction?.chainHash ?? null,
              transactionTimeStamp: transaction?.timeStamp ?? null,
            };
          }),
      },
    };
  }

  /**
   * Vincula al usuario autenticado como Collaborator de un documento al que fue invitado solo
   * por email (accountId todavía null) — ver historia "Notificación por Email para Firma
   * Simple y Vinculación de Cuenta". Empareja por email (case-insensitive) porque, mientras el
   * colaborador no tiene accountId, el email es la única señal disponible para identificarlo.
   *
   * Dos callers:
   *  - PATCH /document/:id/link-collaborator (Casos B/C: recién completado registro/login desde
   *    el enlace del correo, el frontend lo llama explícitamente antes de redirigir al documento).
   *  - sign() (Caso A: sesión ya activa al llegar desde el enlace — vinculación perezosa).
   *
   * No lanza si no hay nada que vincular (`linked: false`): no tener una invitación pendiente
   * con ese email no es un error, es el caso normal para cualquier documento sin este flujo.
   */
  async linkPendingCollaboratorAccount(
    documentId: string,
    currentUserId: string,
  ): Promise<BaseResponse<{ linked: boolean }>> {
    const user = await this.userService.findOne(currentUserId);

    const collaborator = await this.collaboratorRepository.findOne({
      where: {
        documentId,
        email: ILike(user.email),
        accountId: IsNull(),
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      },
    });

    if (!collaborator) {
      return {
        success: true,
        message: 'No hay ninguna invitación pendiente para vincular',
        data: { linked: false },
      };
    }

    const accountId =
      await this.accountMemberService.findPersonalAccountId(currentUserId);
    await this.collaboratorRepository.update(collaborator.id, { accountId });

    return {
      success: true,
      message: 'Cuenta vinculada correctamente al documento',
      data: { linked: true },
    };
  }

  /**
   * Resuelve `myParticipant` (+ el arreglo completo de firmantes) para un documento, e intenta
   * vincular al usuario autenticado por email si todavía no aparece como colaborador — Caso A de
   * "Notificación por Email para Firma Simple y Vinculación de Cuenta": llegó ya autenticado
   * desde el enlace del correo, con su fila de Collaborator aún sin accountId.
   *
   * Bug corregido: antes solo sign() tenía este comportamiento — reject() (y por extensión
   * cualquier firmante que llegara ya autenticado y su primera acción fuera rechazar, no firmar)
   * se topaba con un ForbiddenException aunque su email sí coincidiera con una invitación
   * pendiente. Compartir esta resolución entre ambos flujos cierra esa asimetría.
   */
  private async findOrLinkMySignerCollaborator(
    documentId: string,
    currentUserId: string,
    relations: FindOptionsRelations<CollaboratorEntity>,
  ): Promise<{
    signerCollaborators: CollaboratorEntity[];
    myParticipant: CollaboratorEntity | undefined;
  }> {
    let signerCollaborators = await this.collaboratorRepository.find({
      where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
      relations,
      order: { signingOrder: 'ASC' },
    });

    let myParticipant = signerCollaborators.find(
      (c) => c.account?.userId === currentUserId,
    );

    if (!myParticipant) {
      const linkResult = await this.linkPendingCollaboratorAccount(
        documentId,
        currentUserId,
      );
      if (linkResult.data.linked) {
        signerCollaborators = await this.collaboratorRepository.find({
          where: { documentId, colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER },
          relations,
          order: { signingOrder: 'ASC' },
        });
        myParticipant = signerCollaborators.find(
          (c) => c.account?.userId === currentUserId,
        );
      }
    }

    return { signerCollaborators, myParticipant };
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

  /**
   * Vista pública (sin autenticación) de un documento — ver historia "Visualización pública de
   * documentos firmados mediante MinIO". A diferencia de `getDocumentMinioURL`/
   * `findDetailForUser` (que resuelven una URL de Minio para CUALQUIER estatus vía
   * STATUS_BUCKET_MAP, apoyados en que ya hubo un chequeo de acceso previo), esta ruta no tiene
   * ningún control de acceso — cualquiera con el UUID puede llamarla — así que el gate por
   * `status === SIGNED` ocurre ANTES de siquiera considerar Minio: si el documento no está
   * firmado, ni se resuelve el bucket ni se llama a `minioService.getFile` (que es lo único que
   * genera la URL prefirmada), evitando exponer el archivo de un documento pendiente, rechazado,
   * cancelado o expirado.
   */
  async getPublicDocumentView(
    documentId: string,
  ): Promise<DocumentPublicViewResponse> {
    const document = await this.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.SIGNED) {
      return {
        success: true,
        message: 'Documento obtenido correctamente',
        data: {
          id: document.id,
          fileName: document.fileName,
          status: document.status,
          secureUrl: null,
          expiresIn: null,
        },
      };
    }

    const { secureUrl, expiresIn } = await this.minioService.getFile(
      document.objectKey,
      BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
    );

    return {
      success: true,
      message: 'Documento obtenido correctamente',
      data: {
        id: document.id,
        fileName: document.fileName,
        status: document.status,
        secureUrl,
        expiresIn,
      },
    };
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

  /**
   * Verifica si el usuario tiene acceso al documento (creador o colaborador). Usado para proteger
   * la descarga del archivo.
   *
   * Mismo criterio que `resolveMyCollaborator`: por cuenta vinculada o, si la invitación sigue
   * pendiente de vincular, por email. Sin esto la pantalla de detalle cargaba pero el archivo
   * no (el visor pedía `/document/file/:id` y recibía 403), dejando la firma a medias.
   */
  async assertUserHasAccess(
    documentId: string,
    userId: string,
  ): Promise<DocumentEntity> {
    const document = await this.findOne(documentId);
    if (document.createdBy === userId) {
      return document;
    }

    const linkedCollaborator = await this.collaboratorRepository.findOne({
      where: { documentId, account: { userId } },
    });
    if (linkedCollaborator) {
      return document;
    }

    const user = await this.userService.findOne(userId);
    const invitedCollaborator = user.email
      ? await this.collaboratorRepository.findOne({
          where: {
            documentId,
            accountId: IsNull(),
            email: ILike(user.email),
          },
        })
      : null;
    if (!invitedCollaborator) {
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
      relations: { account: { user: true } },
    });
    const nextSigner = getNextPendingSigner(signerCollaborators);

    if (!nextSigner) return;

    const document = await this.findOne(documentId);
    const creator = await this.userService.findOne(document.createdBy);
    const signerEmail = collaboratorEmail(nextSigner);

    await this.emailService.sendDocumentPendingNotification(
      signerEmail,
      collaboratorDisplayName(nextSigner),
      creator.email,
      document.fileName,
      buildDocumentAccessUrl(documentId, nextSigner.id, signerEmail),
      buildAllDocumentsUrl(),
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
   * Valida el `.key`/`.cer`/contraseña de e.firma del firmante FIEL y ejecuta la firma
   * criptográfica sobre el documento actual. Delega toda la validación real (contraseña,
   * vigencia del certificado, cadena de confianza SAT, correspondencia llave/certificado) a
   * `EfirmaService.firmar` — este servicio nunca se expone como endpoint independiente, solo se
   * invoca aquí. Los errores de `EfirmaService` (422, mensajes claros en español) se propagan
   * tal cual, sin envolverlos.
   */
  private async validateAndSignWithEfirma(
    document: DocumentEntity,
    input: AdvancedSignatureInput | undefined,
  ): Promise<SignatureResult> {
    const { password, keyFile, cerFile } = input ?? {};

    if (!keyFile) {
      throw new BadRequestException(
        'Falta el archivo de la llave privada (.key)',
      );
    }
    if (!cerFile) {
      throw new BadRequestException('Falta el archivo del certificado (.cer)');
    }
    if (!password) {
      throw new BadRequestException('Falta la contraseña de la llave privada');
    }
    if (!keyFile.originalname.toLowerCase().endsWith('.key')) {
      throw new BadRequestException(
        'El archivo de la llave privada debe tener extensión .key',
      );
    }
    if (!cerFile.originalname.toLowerCase().endsWith('.cer')) {
      throw new BadRequestException(
        'El archivo del certificado debe tener extensión .cer',
      );
    }
    if (keyFile.size > MAX_EFIRMA_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `El archivo .key excede el tamaño máximo permitido (${Math.floor(MAX_EFIRMA_FILE_SIZE_BYTES / 1024)}KB)`,
      );
    }
    if (cerFile.size > MAX_EFIRMA_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `El archivo .cer excede el tamaño máximo permitido (${Math.floor(MAX_EFIRMA_FILE_SIZE_BYTES / 1024)}KB)`,
      );
    }

    const documentBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.CREATED_DOCUMENTS,
    );

    return this.efirmaService.firmar(
      documentBuffer,
      cerFile.buffer,
      keyFile.buffer,
      password,
    ) as SignatureResult;
  }

  /**
   * Copia la imagen de firma activa del usuario (ya validada por `assertUserHasSignatureOnFile`)
   * a un object key nuevo e inmutable en MinIO, y retorna esa clave. Ver docblock de
   * `CollaboratorEntity.signatureSnapshotObjectKey` para el porqué: sin este snapshot, el PDF
   * final quedaría vinculado a lo que sea que el usuario tenga en su perfil al momento en que
   * el ÚLTIMO firmante termine, no a lo que realmente firmó.
   */
  private async snapshotSignatureImage(user: UserEntity): Promise<string> {
    const signature = await this.signatureService.findOne(
      user.signatureId as string,
    );
    const signatureBuffer = await this.minioService.getFileInBytesFormat(
      signature.signatureObjectKey,
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
    const snapshot = await this.minioService.uploadObject(
      {
        file: signatureBuffer,
        name: 'signature-snapshot.png',
        mimetype: 'image/png',
      },
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
    return snapshot.fileId;
  }

  /**
   * Encuentra la fila de Collaborator (SIGNER) del usuario autenticado en este documento, o
   * lanza ForbiddenException. Usado por el flujo de verificación (emitir/validar código) —
   * mismo criterio de acceso que sign()/reject().
   *
   * Bug corregido (encontrado probando el flujo completo de Firma Simple de punta a punta): el
   * Caso A de "Notificación por Email para Firma Simple y Vinculación de Cuenta" (usuario ya
   * autenticado, su Collaborator todavía sin accountId) solo estaba resuelto dentro de sign()/
   * reject(), no aquí. Pero Firma Simple SIEMPRE exige 2FA, y el código se solicita ANTES de
   * firmar — un firmante en Caso A nunca lograba pedir su código (se topaba con
   * ForbiddenException aquí primero), así que jamás llegaba a sign() para que la vinculación
   * perezosa de ahí lo rescatara. Se aplica el mismo criterio aquí.
   */
  private async findMySignerCollaborator(
    documentId: string,
    currentUserId: string,
  ): Promise<CollaboratorEntity> {
    const relations = { account: { user: true } };
    const findMine = () =>
      this.collaboratorRepository.findOne({
        where: {
          documentId,
          account: { userId: currentUserId },
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
        relations,
      });

    let myParticipant = await findMine();

    if (!myParticipant) {
      const linkResult = await this.linkPendingCollaboratorAccount(
        documentId,
        currentUserId,
      );
      if (linkResult.data.linked) {
        myParticipant = await findMine();
      }
    }

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    return myParticipant;
  }

  /**
   * Emite y envía por correo un código de verificación para que el firmante autenticado pueda
   * firmar un documento con requiresVerification=true.
   *
   * Bug corregido: el envío del correo se hacía sin protección después de persistir el código, así
   * que una caída del proveedor (SendGrid) tumbaba toda la petición con un 500 — el código ya
   * estaba emitido en la base, pero la pantalla de firma nunca llegaba a mostrar el campo para
   * capturarlo y el firmante quedaba sin poder firmar *ni rechazar*. El registro de usuarios ya
   * trataba este mismo fallo como no fatal (ver `UserService`: advierte y continúa); aquí se
   * unifica ese criterio: el resultado del envío se reporta en `emailDelivered` para que la UI
   * pueda avisar y ofrecer el reenvío, en vez de dejar al usuario sin salida.
   */
  async requestVerificationCode(
    documentId: string,
    currentUserId: string,
    ipAddress: string,
  ): Promise<BaseResponse<{ emailDelivered: boolean }>> {
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

    const recipient = collaboratorEmail(myParticipant);
    let emailDelivered = true;

    try {
      await this.emailService.sendVerificationCodeNotification(
        recipient,
        document.fileName,
        verificationCode.code,
      );
    } catch (error) {
      emailDelivered = false;
      this.logger.warn(
        `No se pudo enviar el código de verificación de firma a ${recipient} (documento ${documentId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      success: true,
      message: emailDelivered
        ? 'Código de verificación enviado correctamente'
        : 'El código de verificación quedó emitido, pero no se pudo enviar el correo. Solicita un reenvío si no lo recibes.',
      data: { emailDelivered },
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
    advancedSignatureInput?: AdvancedSignatureInput,
    geolocation?: GeolocationDto,
  ): Promise<BaseResponse<{ id: string }>> {
    // La ubicación es obligatoria para firmar. El DTO ya la exige (400 desde ValidationPipe),
    // pero se revalida aquí porque `sign()` también se invoca desde otros puntos internos y una
    // firma sin esta evidencia no debe poder registrarse por ninguna vía.
    if (!geolocation) {
      throw new BadRequestException(
        'La geolocalización es obligatoria para poder firmar el documento',
      );
    }

    const document = await this.findOne(documentId);

    if (document.status !== DOCUMENT_STATUS_ENUM.PENDING) {
      throw new BadRequestException(
        `El documento no puede firmarse. Solo se permiten documentos con estatus '${DOCUMENT_STATUS_ENUM.PENDING}', el estatus actual es '${document.status}'`,
      );
    }

    const { signerCollaborators, myParticipant } =
      await this.findOrLinkMySignerCollaborator(documentId, currentUserId, {
        account: { user: true },
        simpleSignature: true,
      });

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    if (myParticipant.status !== SIGNEE_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    if (
      !isSignerTurn(myParticipant, signerCollaborators, document.isSequential)
    ) {
      throw new ForbiddenException(
        'Aún no es tu turno para firmar este documento',
      );
    }

    // La validación de e.firma (contraseña, vigencia del certificado, cadena de confianza,
    // correspondencia llave/certificado — todo vía EfirmaService) corre ANTES del claim atómico
    // a propósito: si falla (contraseña incorrecta es el caso más común, se espera que el
    // firmante reintente), no debe dejar al colaborador marcado como SIGNED sin una firma válida
    // detrás. Para firma simple, el equivalente es `assertUserHasSignatureOnFile`.
    let advancedSignatureResult: SignatureResult | null = null;
    if (myParticipant.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
      advancedSignatureResult = await this.validateAndSignWithEfirma(
        document,
        advancedSignatureInput,
      );
    } else {
      await this.assertUserHasSignatureOnFile(myParticipant.account!.user);
    }

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

    // Claim atómico (bug corregido): un UPDATE condicionado a status=PENDING es lo único que
    // realmente cierra la ventana de carrera entre dos peticiones casi simultáneas para el
    // mismo firmante (doble clic, dos pestañas, reintento por timeout) — la validación en
    // memoria de arriba (`myParticipant.status !== PENDING`) no alcanza porque ambas peticiones
    // pueden pasarla antes de que cualquiera escriba. Si `affected !== 1`, alguien más ya ganó
    // la carrera; se aborta aquí, antes de tocar MinIO/estampado/correos, así que no hay
    // estampado duplicado, correos duplicados a todos los colaboradores, ni auditoría duplicada.
    const claim = await this.collaboratorRepository.update(
      { id: myParticipant.id, status: SIGNEE_STATUS_ENUM.PENDING },
      { status: SIGNEE_STATUS_ENUM.SIGNED, signedAt: new Date() },
    );
    if (claim.affected !== 1) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }
    myParticipant.status = SIGNEE_STATUS_ENUM.SIGNED;
    myParticipant.signedAt = new Date();
    // Evidencia declarada por el dispositivo del firmante (navigator.geolocation), no verificada
    // independientemente por el servidor. Siempre presente: firmar sin ubicación se rechaza al
    // inicio de este método y en el DTO.
    myParticipant.geoLoc = geolocation;

    if (myParticipant.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
      // Resultado ya validado arriba (antes del claim) — solo se persiste. No contiene la llave
      // privada ni la contraseña, ver docblock de `CollaboratorEntity.advancedSignature`.
      myParticipant.advancedSignature = advancedSignatureResult;
    } else {
      // Snapshot inmutable tomado AHORA, en el momento real de la firma — ver docblock de
      // `signatureSnapshotObjectKey` y la migración asociada. Sin esto, finalizeSignedDocument()
      // (que corre después, cuando firma el ÚLTIMO firmante) volvería a leer la firma EN VIVO de
      // cada colaborador, y un firmante que desactivó su firma entre que firmó y que el último
      // terminó quedaría con un PNG en blanco estampado en el PDF legal final, sin ningún error.
      // Se toma después del claim a propósito: si el claim se pierde, no se desperdicia esta
      // llamada a MinIO.
      myParticipant.signatureSnapshotObjectKey =
        await this.snapshotSignatureImage(
          myParticipant.account!.user as UserEntity,
        );
    }

    const remainingSigners = signerCollaborators.filter(
      (c) =>
        c.id !== myParticipant.id && c.status === SIGNEE_STATUS_ENUM.PENDING,
    );

    // Si soy el último firmante pendiente, estampo y finalizo el documento ANTES de
    // registrar mi firma: si el estampado falla, ni el colaborador ni el documento
    // quedan marcados como firmados, y la firma puede reintentarse sin quedar atascada.
    document.completedSignersCount = (document.completedSignersCount ?? 0) + 1;

    if (remainingSigners.length === 0) {
      // finalizeSignedDocument guarda `document` (ya con completedSignersCount incrementado).
      await this.finalizeSignedDocument(document, signerCollaborators);
      // Sellado con Seal Service: recién acá el documento tiene TODAS sus firmas avanzadas, que
      // es lo que el proveedor necesita para construir un único hash sellado del conjunto.
      await this.sealAdvancedSignatures(document, signerCollaborators);
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

    // El claim atómico ya persistió status/signedAt — este save solo persiste
    // signatureSnapshotObjectKey (y re-escribe status/signedAt con el mismo valor, sin efecto).
    await this.collaboratorRepository.save(myParticipant);

    // Bug corregido: este evento alimenta el encadenamiento de DocumentTransaction y del ledger
    // global de auditoría (ver Kafka -> DocumentEventsConsumer) — se dispara AQUÍ, después de
    // que el snapshot de la firma ya quedó tomado y persistido, no justo tras el claim atómico.
    // Si se disparara antes y `snapshotSignatureImage` (llamada a MinIO) fallara, el evento ya
    // publicado dejaría un registro de "firmado" en ambas cadenas para una firma cuyo
    // signatureSnapshotObjectKey nunca se llegó a guardar — y el firmante, al reintentar, se
    // encontraría bloqueado por el claim atómico ("ya respondiste") sin poder corregirlo. Se
    // dispara por CADA firmante (no solo el último, a diferencia de emitSigned más abajo).
    this.documentEventsProducer.emitCollaboratorSigned({
      documentId,
      fileName: document.fileName,
      actorUserId: currentUserId,
      collaboratorId: myParticipant.id,
      signedAt: myParticipant.signedAt.toISOString(),
    });

    void this.auditService.create({
      documentId,
      operation: AuditAction.DOCUMENT_SIGNED,
      ipAddress: document.ipAddress ?? '0.0.0.0',
      users: [{ userId: currentUserId, action: AuditAction.DOCUMENT_SIGNED }],
      signedAt: myParticipant.signedAt,
      geolocation,
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

  /**
   * Envía a Seal Service el arreglo con las firmas avanzadas del documento y persiste la
   * evidencia que devuelve (historia "Completar flujo de firma avanzada e integración con Seal
   * Service"). Corre una sola vez por documento, cuando el último firmante terminó: el proveedor
   * calcula UN hash canónico sobre el conjunto completo de firmas, así que sellar antes —firma
   * por firma— produciría un hash de un conjunto parcial que ya no representa al documento final.
   *
   * Un documento sin ninguna firma avanzada (todo firma simple) no se sella: no hay firma
   * criptográfica de la cual construir la evidencia.
   *
   * Best-effort a propósito, igual que los correos de finalización: llegado este punto las firmas
   * ya están registradas y el PDF ya está en el bucket de firmados. Propagar un fallo del
   * proveedor devolvería un 500 al último firmante por algo que su firma sí logró, y su reintento
   * chocaría contra el claim atómico ("ya respondiste") sin poder corregir nada. El error queda
   * logueado, y el sellado puede reintentarse contra `POST /seal` con el mismo payload.
   */
  private async sealAdvancedSignatures(
    document: DocumentEntity,
    signerCollaborators: CollaboratorEntity[],
  ): Promise<void> {
    const advancedSigners = signerCollaborators.filter(
      (collaborator) =>
        collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL &&
        collaborator.advancedSignature !== null &&
        collaborator.advancedSignature !== undefined,
    );

    if (advancedSigners.length === 0) {
      return;
    }

    // La traducción del payload va DENTRO del try junto con la llamada: si una firma guardada
    // tuviera una forma inesperada, el error debe tratarse como cualquier otro fallo de sellado
    // (logueado, sin efecto sobre la firma) y no escaparse como una excepción no controlada al
    // final de un flujo de firma que ya se completó.
    try {
      const sealDocumentDto: SealDocumentDto = {
        documentId: document.id,
        originalHash: document.originalHash,
        signatures: advancedSigners.map((collaborator) =>
          this.toSealSignature(collaborator.advancedSignature!),
        ),
      };

      const seal = await this.sealDocumentUseCase.create(sealDocumentDto);
      this.logger.log(
        `Sellos generados para el documento ${document.id} (evidencia ${seal.id}, ${advancedSigners.length} firma(s) avanzada(s)).`,
      );
    } catch (error) {
      this.logger.error(
        `Error sellando el documento ${document.id} con Seal Service: ${error}`,
      );
    }
  }

  /**
   * Traduce el resultado de `EfirmaService.firmar` (persistido tal cual en
   * `CollaboratorEntity.advancedSignature`) al contrato que espera Seal Service.
   *
   * `signedAt` se normaliza a ISO 8601 pasando por `Date` porque el mismo campo llega como `Date`
   * cuando la firma se acaba de hacer en esta misma petición, y como string cuando se releyó de la
   * columna jsonb — el proveedor ordena y canonicaliza las firmas por este valor, así que las dos
   * rutas tienen que producir exactamente el mismo texto.
   */
  private toSealSignature(
    signature: SignatureResult,
  ): SealDocumentDto['signatures'][number] {
    return {
      signatureBase64: String(signature.signatureBase64),
      algorithm: signature.algorithm,
      signedAt: new Date(signature.signedAt).toISOString(),
      certificate: {
        rfc: signature.certificate.rfc,
        name: signature.certificate.name,
        serialNumber: signature.certificate.serialNumber,
        certificateNumber: signature.certificate.certificateNumber,
        certificatePem: signature.certificate.certificatePem,
      },
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
        // Firma electrónica avanzada (FIEL): la evidencia es criptográfica (ver
        // `CollaboratorEntity.advancedSignature`, poblado en `sign()`), no una imagen — no hay
        // nada que estampar visualmente en el PDF para este colaborador.
        if (collaborator.signatureType === SIGNATURE_TYPE_ENUM.FIEL) {
          continue;
        }

        // Los firmantes siempre tienen cuenta de plataforma (accountId no-nulo): solo watchers
        // y reviewers pueden invitarse por email únicamente (ver create()). Fallback defensivo
        // por si la relación account.user no vino cargada (no debería pasar: signerCollaborators
        // siempre se consulta con relations: { account: { user: true } }).
        const signerUser =
          collaborator.account?.user ??
          (await this.userService.findOne(
            (
              await this.collaboratorRepository.findOneOrFail({
                where: { id: collaborator.id },
                relations: { account: { user: true } },
              })
            ).account!.userId,
          ));

        // Usa el snapshot inmutable tomado en el momento real de la firma (ver
        // `signatureSnapshotObjectKey` / `snapshotSignatureImage`) — NO la firma en vivo del
        // perfil del usuario, que pudo haber sido desactivada/reemplazada después de firmar.
        // El fallback a la firma en vivo es solo defensivo, para filas ya firmadas antes de
        // este fix que todavía no tienen snapshot.
        const signatureObjectKey =
          collaborator.signatureSnapshotObjectKey ??
          (await this.signatureService.findOne(signerUser.signatureId))
            .signatureObjectKey;
        const signatureBuffer = await this.minioService.getFileInBytesFormat(
          signatureObjectKey,
          BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
        );

        const signerName = `${signerUser.firstName} ${signerUser.lastName}`;

        if (collaborator.simpleSignature) {
          // Firmante creado por el flujo nuevo (ver historia "Ubicación de firmas por
          // usuario"): un arreglo vacío significa que no colocó ninguna posición — se firma
          // sin estampar nada visualmente, y el loop de abajo simplemente no itera. Con
          // elementos, se estampa UNA vez por cada posición (páginas/zonas distintas).
          for (const position of collaborator.simpleSignature
            .signatureCoordinates) {
            if (isRatioSignaturePosition(position)) {
              const { coordinates, pageIndex } =
                await this.documentSigningSerivice.resolveRatioPosition(
                  documentBuffer,
                  position,
                );
              documentBuffer =
                await this.documentSigningSerivice.mergeSignatureIntoPdf(
                  documentBuffer,
                  signatureBuffer,
                  coordinates,
                  pageIndex,
                );
              documentBuffer = await this.documentSigningSerivice.addSignerName(
                documentBuffer,
                signerName,
                coordinates,
                pageIndex,
              );
            } else {
              // Dato legacy (pre-migración `ArraySignatureCoordinates`, en píxeles absolutos,
              // sin ratios) — se respeta el comportamiento de siempre: página por defecto
              // (última), sin intentar una conversión a ratios con pérdida de precisión.
              const legacyCoordinates: SignatureCoordinates = {
                x: position.x,
                y: position.y,
                width: position.width,
                height: position.height,
                opacity: position.opacity,
              };
              documentBuffer =
                await this.documentSigningSerivice.mergeSignatureIntoPdf(
                  documentBuffer,
                  signatureBuffer,
                  legacyCoordinates,
                );
              documentBuffer = await this.documentSigningSerivice.addSignerName(
                documentBuffer,
                signerName,
                legacyCoordinates,
              );
            }
          }
        } else {
          // Colaborador creado por el endpoint POST /document más antiguo (nunca asigna
          // simpleSignatureId) — apilado automático sin cambios respecto al comportamiento
          // previo a esta historia.
          const coordinates: SignatureCoordinates = {
            ...baseCoordinates,
            y: baseCoordinates.y + autoStackIndex * verticalStep,
          };
          autoStackIndex += 1;

          documentBuffer =
            await this.documentSigningSerivice.mergeSignatureIntoPdf(
              documentBuffer,
              signatureBuffer,
              coordinates,
            );
          documentBuffer = await this.documentSigningSerivice.addSignerName(
            documentBuffer,
            signerName,
            coordinates,
          );
        }
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

  /**
   * Envía el PDF final firmado por correo a todos los colaboradores (firmantes, watchers y
   * reviewers) y, por separado, a quien creó el documento — que no siempre es también un
   * colaborador, así que sin esto se quedaba sin ningún aviso de que ya se completó la firma.
   */
  private async sendCompletionEmails(documentId: string): Promise<void> {
    const document = await this.findOne(documentId);
    const collaborators = await this.collaboratorRepository.find({
      where: { documentId },
      relations: { account: { user: true } },
    });
    const creator = await this.userService.findOne(document.createdBy);

    const signedBuffer = await this.minioService.getFileInBytesFormat(
      document.objectKey,
      BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
    );

    const signerNames = collaborators
      .filter((c) => c.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER)
      .map(collaboratorDisplayName);

    await Promise.all([
      ...collaborators.map((collaborator) =>
        this.emailService.sendDocumentSignedNotification(
          collaboratorEmail(collaborator),
          collaboratorDisplayName(collaborator),
          document.fileName,
          signedBuffer,
        ),
      ),
      this.emailService.sendDocumentCompletedToCreatorNotification(
        creator.email,
        `${creator.firstName} ${creator.lastName}`,
        document.fileName,
        signerNames,
        signedBuffer,
      ),
    ]);
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

    const { signerCollaborators, myParticipant } =
      await this.findOrLinkMySignerCollaborator(documentId, currentUserId, {
        account: { user: true },
      });

    if (!myParticipant) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    if (myParticipant.status !== SIGNEE_STATUS_ENUM.PENDING) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }

    if (
      !isSignerTurn(myParticipant, signerCollaborators, document.isSequential)
    ) {
      throw new ForbiddenException(
        'Aún no es tu turno para revisar este documento',
      );
    }

    await this.assertUserHasSignatureOnFile(myParticipant.account!.user);

    // Claim atómico (mismo criterio que sign(), ver su comentario): cierra la ventana de
    // carrera de un doble clic/doble pestaña rechazando antes de tocar MinIO/estampado.
    const claim = await this.collaboratorRepository.update(
      { id: myParticipant.id, status: SIGNEE_STATUS_ENUM.PENDING },
      { status: SIGNEE_STATUS_ENUM.REJECTED, cancellationReason: reason },
    );
    if (claim.affected !== 1) {
      throw new BadRequestException('Ya respondiste a esta solicitud de firma');
    }
    myParticipant.status = SIGNEE_STATUS_ENUM.REJECTED;
    myParticipant.cancellationReason = reason;

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

    // status/cancellationReason ya se persistieron atómicamente en el claim de arriba.

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
      relations: { account: { user: true } },
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
      relations: { account: { user: true } },
    });

    const isSigner = collaborators.some(
      (c) =>
        c.account?.userId === currentUserId &&
        c.colaboratorType === COLABORATOR_TYPE_ENUM.SIGNER,
    );
    if (!isSigner) {
      throw new ForbiddenException('No eres firmante de este documento');
    }

    // Claim atómico (mismo criterio que sign()/reject()): "cualquier firmante puede confirmar"
    // significa que dos firmantes distintos (o el mismo, doblemente) podrían pasar el check de
    // arriba casi al mismo tiempo — sin este UPDATE condicionado, ambos estamparían y subirían
    // a MinIO, y todos los colaboradores recibirían el correo de cancelación duplicado.
    const cancelledAt = new Date();
    const claim = await this.documentRepository.update(
      { id: documentId, status: DOCUMENT_STATUS_ENUM.CANCELLATION_PENDING },
      { status: DOCUMENT_STATUS_ENUM.CANCELLED, cancelledAt },
    );
    if (claim.affected !== 1) {
      throw new BadRequestException(
        'La cancelación de este documento ya fue confirmada',
      );
    }
    document.status = DOCUMENT_STATUS_ENUM.CANCELLED;
    document.cancelledAt = cancelledAt;

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

    // status/cancelledAt ya se persistieron atómicamente en el claim de arriba.

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
