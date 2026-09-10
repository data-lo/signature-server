import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AccountMemberService } from 'src/account/account-member.service';
import { AuditService } from 'src/audit/audit.service';
import { AuditAction } from 'src/audit/schema/audit-document';
import { BaseResponse } from 'src/interfaces/api-response.dto';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { HashService } from 'src/common/hash/hash.service';
import { MinioService } from 'src/common/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';
import { FILE_STATUS_ENUM } from 'src/common/minio/enums/file-status-enum';
import { PdfSignatureService } from 'src/common/document-signing/document-signing.service';
import { DEFAULT_COORDINATES } from 'src/common/document-signing/interfaces/default-signing-coordinates.interface';
import { MAX_PDF_FILE_SIZE_BYTES } from 'src/common/constants/file-upload.constants';
import { UserService } from 'src/user/user.service';

import { CreateDocumentDto } from '../dto/create-document.dto';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentTransactionService } from '../document-transaction.service';
import { DocumentService } from '../document.service';

/**
 * Da de alta un documento con sus colaboradores (firmantes, observadores y revisores).
 *
 * @remarks
 * Flujo:
 *
 * 1. Comprueba que el usuario sea miembro activo de la cuenta del header.
 * 2. Valida el archivo: que venga y que no pase del tamaño máximo.
 * 3. Rechaza participantes repetidos, por id y por correo, entre los tres roles.
 * 4. Rechaza un documento con el mismo nombre ya pendiente de firma del mismo autor.
 * 5. Sube el PDF a MinIO, cuenta sus páginas y calcula el hash original.
 * 6. Guarda el documento y sus colaboradores, anclados a la cuenta personal del invitado.
 * 7. Abre la transacción de auditoría del documento y publica el evento de creación.
 *
 * El documento nace en `CREATED`, todavía sin salir a firmar: el alta y el envío son dos pasos
 * distintos para que quien lo crea pueda acomodar las posiciones de firma antes de que nadie
 * reciba nada.
 *
 * **No consume ningún crédito de documento.** Es el flujo antiguo, anterior a la facturación por
 * documento; quien cobra es `CreateDocumentSignatureFlowUseCase`
 * (`POST /documents/signatures`), que es el que usa el frontend. Por lo mismo este alta tampoco
 * fija el tipo de firma del documento, y sus filas quedan con `signature_type` en `null`.
 *
 * Sólo los firmantes necesitan cuenta en la plataforma —les hace falta firma e INE registradas—;
 * observadores y revisores pueden invitarse sólo por correo.
 */
@Injectable()
export class CreateDocumentUseCase {
  private readonly logger = new Logger(CreateDocumentUseCase.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(CollaboratorEntity)
    private readonly collaboratorRepository: Repository<CollaboratorEntity>,
    private readonly minioService: MinioService,
    private readonly hashService: HashService,
    private readonly userService: UserService,
    private readonly documentSigningSerivice: PdfSignatureService,
    private readonly auditService: AuditService,
    private readonly documentEventsProducer: DocumentEventsProducer,
    private readonly accountMemberService: AccountMemberService,
    private readonly documentTransactionService: DocumentTransactionService,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * Ejecuta el caso de uso.
   *
   * @param createdBy Usuario que crea el documento.
   * @param accountId Cuenta activa (`X-Account-Id`) en la que queda el documento.
   * @param createDocumentDto Participantes por rol y coordenadas de firma.
   * @param file PDF subido en el multipart.
   * @param ip IP del solicitante, que se guarda en el documento y en cada colaborador como
   *   evidencia del alta.
   * @returns El documento creado con sus participantes y una URL temporal para verlo.
   * @throws {BadRequestException} Cuando falta el header de cuenta activa, no viene archivo, el
   *   PDF pasa del tamaño máximo, hay participantes repetidos, o el autor ya tiene un documento
   *   con ese nombre pendiente de firma.
   * @throws {ForbiddenException} Cuando el usuario no es miembro activo de la cuenta.
   * @throws {NotFoundException} Cuando alguno de los participantes no existe.
   */
  async execute(
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

      // Los collaborators anclan a la cuenta PERSONAL del invitado, no a su userId crudo.
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

      const url = await this.documentService.getDocumentMinioURL(
        savedDocument.id,
      );
      const { signers, watchers, reviewers } =
        await this.documentService.getCollaboratorNames(savedDocument.id);
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
}
