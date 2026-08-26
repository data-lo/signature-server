import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsRelations, Repository } from 'typeorm';

import { MinioService } from 'src/shared/minio/minio.service';

import { DocumentEntity } from '../entities/document.entity';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNEE_STATUS_ENUM } from '../enum/signee-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';
import {
  collaboratorDisplayName,
  collaboratorEmail,
} from '../utils/collaborator-display.util';
import { isSignerTurn } from '../utils/next-signer.util';
import { DocumentTransactionService } from '../document-transaction.service';
import { VerificationCodeService } from '../verification-code.service';
import { DocumentService } from '../document.service';

/**
 * `GET /document/:id`: el detalle que alimenta la pantalla de firma.
 *
 * Además del documento, resuelve qué es el usuario dentro de él —creador, firmante en turno,
 * firmante que ya respondió, observador—, porque de eso depende todo lo que la pantalla le
 * ofrece.
 */
@Injectable()
export class GetDocumentUseCase {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly minioService: MinioService,
    private readonly documentTransactionService: DocumentTransactionService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly documentService: DocumentService,
  ) {}

  async execute(documentId: string, currentUserId: string) {
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
    const myParticipant = await this.documentService.resolveMyCollaborator(
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

    const bucket = this.documentService.resolveDocumentBucket(document);
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
}
