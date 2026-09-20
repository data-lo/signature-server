import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from 'src/audit/audit.service';
import { AuditAction } from 'src/audit/schema/audit-document';
import { DocumentEventsProducer } from 'src/kafka/document-events.producer';
import { DOCUMENT_KAFKA_TOPICS } from 'src/kafka/document-events.topics';

import { ApproveDocumentUseCase } from './approve-document.use-case';
import { RejectDocumentApprovalUseCase } from './reject-document-approval.use-case';
import { DocumentService } from '../document.service';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { DocumentEntity } from '../entities/document.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { DocumentApprovalService } from '../services/document-approval.service';

const REVIEWER_USER_ID = 'user-reviewer';

function givenDocument(overrides: Partial<DocumentEntity> = {}) {
  return {
    id: 'doc-1',
    fileName: 'contrato.pdf',
    requiresApproval: true,
    status: DOCUMENT_STATUS_ENUM.PENDING_APPROVAL,
    ipAddress: '127.0.0.1',
    createdBy: 'user-creador',
    ...overrides,
  } as DocumentEntity;
}

function givenReviewer(overrides: Partial<CollaboratorEntity> = {}) {
  return {
    id: 'collab-reviewer',
    documentId: 'doc-1',
    colaboratorType: COLABORATOR_TYPE_ENUM.REVIEWER,
    status: COLLABORATOR_STATUS_ENUM.PENDING,
    account: { userId: REVIEWER_USER_ID },
    ...overrides,
  } as CollaboratorEntity;
}

/**
 * Historia "Implementar flujo de aprobación previo al proceso de firma".
 *
 * Las validaciones se prueban una sola vez, contra `DocumentApprovalService`, porque aprobar y
 * rechazar las comparten: duplicarlas por caso de uso probaría dos veces el mismo código y
 * dejaría de avisar el día que dejen de ser las mismas.
 */
describe('flujo de aprobación', () => {
  let approvalService: DocumentApprovalService;
  let approveDocument: ApproveDocumentUseCase;
  let rejectApproval: RejectDocumentApprovalUseCase;

  let documentRepository: Record<string, jest.Mock>;
  let collaboratorRepository: Record<string, jest.Mock>;
  let documentService: Record<string, jest.Mock>;
  let auditService: Record<string, jest.Mock>;
  let documentEventsProducer: Record<string, jest.Mock>;
  let managedDocumentRepository: Record<string, jest.Mock>;
  let managedCollaboratorRepository: Record<string, jest.Mock>;

  beforeEach(async () => {
    documentRepository = { findOne: jest.fn() };
    collaboratorRepository = { findOne: jest.fn() };
    documentService = {
      notifyNextSigner: jest.fn().mockResolvedValue(undefined),
      sendSimpleSignatureInvitations: jest.fn().mockResolvedValue(undefined),
      notifyCreatorOfApprovalRejection: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { create: jest.fn().mockResolvedValue(undefined) };
    documentEventsProducer = {
      enqueueApprovalEvent: jest.fn().mockResolvedValue({ id: 'event-1' }),
      flushOutbox: jest.fn().mockResolvedValue(undefined),
      emitSentToSign: jest.fn(),
    };
    managedDocumentRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    managedCollaboratorRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const dataSource = {
      transaction: jest.fn(
        async (runInTransaction: (manager: unknown) => Promise<unknown>) =>
          runInTransaction({
            getRepository: (entity: unknown) =>
              entity === DocumentEntity
                ? managedDocumentRepository
                : managedCollaboratorRepository,
          }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentApprovalService,
        ApproveDocumentUseCase,
        RejectDocumentApprovalUseCase,
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: documentRepository,
        },
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
        { provide: DocumentService, useValue: documentService },
        { provide: AuditService, useValue: auditService },
        { provide: DocumentEventsProducer, useValue: documentEventsProducer },
      ],
    }).compile();

    approvalService = module.get(DocumentApprovalService);
    approveDocument = module.get(ApproveDocumentUseCase);
    rejectApproval = module.get(RejectDocumentApprovalUseCase);
  });

  describe('quién y cuándo puede decidir', () => {
    it('404 si el documento no existe', async () => {
      documentRepository.findOne.mockResolvedValue(null);

      await expect(
        approvalService.loadDecidable('doc-1', REVIEWER_USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('400 si el documento no requiere aprobación', async () => {
      documentRepository.findOne.mockResolvedValue(
        givenDocument({ requiresApproval: false }),
      );

      await expect(
        approvalService.loadDecidable('doc-1', REVIEWER_USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 si el documento ya salió de PENDING_APPROVAL', async () => {
      documentRepository.findOne.mockResolvedValue(
        givenDocument({ status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE }),
      );

      await expect(
        approvalService.loadDecidable('doc-1', REVIEWER_USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404 si el documento requiere aprobación pero no tiene reviewer asignado', async () => {
      documentRepository.findOne.mockResolvedValue(givenDocument());
      collaboratorRepository.findOne.mockResolvedValue(null);

      await expect(
        approvalService.loadDecidable('doc-1', REVIEWER_USER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403 si quien llama no es el reviewer asignado', async () => {
      documentRepository.findOne.mockResolvedValue(givenDocument());
      collaboratorRepository.findOne.mockResolvedValue(givenReviewer());

      await expect(
        approvalService.loadDecidable('doc-1', 'otro-usuario'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    /** Una decisión ya registrada no vuelve a ejecutarse. */
    it('400 si el reviewer ya resolvió', async () => {
      documentRepository.findOne.mockResolvedValue(givenDocument());
      collaboratorRepository.findOne.mockResolvedValue(
        givenReviewer({ status: COLLABORATOR_STATUS_ENUM.APPROVED }),
      );

      await expect(
        approvalService.loadDecidable('doc-1', REVIEWER_USER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('aprobar', () => {
    beforeEach(() => {
      documentRepository.findOne.mockResolvedValue(givenDocument());
      collaboratorRepository.findOne.mockResolvedValue(givenReviewer());
    });

    it('marca al reviewer APPROVED con su fecha de resolución', async () => {
      await approveDocument.execute('doc-1', REVIEWER_USER_ID);

      expect(managedCollaboratorRepository.update).toHaveBeenCalledWith(
        { id: 'collab-reviewer', status: COLLABORATOR_STATUS_ENUM.PENDING },
        expect.objectContaining({
          status: COLLABORATOR_STATUS_ENUM.APPROVED,
          resolvedAt: expect.any(Date),
        }),
      );
    });

    it('deja el documento en PENDING_SIGNATURE', async () => {
      const result = await approveDocument.execute('doc-1', REVIEWER_USER_ID);

      expect(managedDocumentRepository.update).toHaveBeenCalledWith(
        { id: 'doc-1', status: DOCUMENT_STATUS_ENUM.PENDING_APPROVAL },
        { status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE },
      );
      expect(result.data.status).toBe(DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE);
    });

    /**
     * El punto de la historia: aprobar no inventa un flujo de firma propio, engancha con el que
     * ya existe. `notifyNextSigner` es el mismo método que usa el envío a autorización.
     */
    it('arranca el flujo de firma existente y registra auditoría', async () => {
      await approveDocument.execute('doc-1', REVIEWER_USER_ID);

      expect(documentService.notifyNextSigner).toHaveBeenCalledWith('doc-1');
      expect(
        documentService.sendSimpleSignatureInvitations,
      ).toHaveBeenCalledWith('doc-1');
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({ operation: AuditAction.DOCUMENT_APPROVED }),
      );
    });

    /**
     * `document.approved` se registra en la outbox dentro de la transacción y se publica al
     * confirmarla; `document.sent_to_sign` sale por el camino directo, que es el que ya usaban
     * el envío a autorización y el resto del ciclo de vida.
     */
    it('registra document.approved en la outbox, la vacía y publica document.sent_to_sign', async () => {
      await approveDocument.execute('doc-1', REVIEWER_USER_ID);

      expect(documentEventsProducer.enqueueApprovalEvent).toHaveBeenCalledWith(
        expect.anything(),
        DOCUMENT_KAFKA_TOPICS.APPROVED,
        expect.objectContaining({
          documentId: 'doc-1',
          collaboratorId: 'collab-reviewer',
          actorUserId: REVIEWER_USER_ID,
        }),
      );
      expect(documentEventsProducer.flushOutbox).toHaveBeenCalled();
      expect(documentEventsProducer.emitSentToSign).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 'doc-1' }),
      );
    });

    /**
     * Dos peticiones simultáneas pasan las dos por las validaciones: lo que impide la doble
     * decisión es el `affected` del UPDATE condicionado a que el reviewer siga en PENDING.
     */
    it('si otra petición ya reclamó la decisión, no toca el documento', async () => {
      managedCollaboratorRepository.update.mockResolvedValue({ affected: 0 });

      await expect(
        approveDocument.execute('doc-1', REVIEWER_USER_ID),
      ).rejects.toThrow();
      expect(managedDocumentRepository.update).not.toHaveBeenCalled();
    });

    it('un fallo de correo no deshace la aprobación', async () => {
      documentService.notifyNextSigner.mockRejectedValue(new Error('SMTP'));

      const result = await approveDocument.execute('doc-1', REVIEWER_USER_ID);

      expect(result.success).toBe(true);
    });
  });

  describe('rechazar', () => {
    beforeEach(() => {
      documentRepository.findOne.mockResolvedValue(givenDocument());
      collaboratorRepository.findOne.mockResolvedValue(givenReviewer());
    });

    it('marca al reviewer REJECTED con su fecha y su nota', async () => {
      await rejectApproval.execute(
        'doc-1',
        REVIEWER_USER_ID,
        'Falta el anexo B',
      );

      expect(managedCollaboratorRepository.update).toHaveBeenCalledWith(
        { id: 'collab-reviewer', status: COLLABORATOR_STATUS_ENUM.PENDING },
        expect.objectContaining({
          status: COLLABORATOR_STATUS_ENUM.REJECTED,
          resolvedAt: expect.any(Date),
          resolutionNote: 'Falta el anexo B',
        }),
      );
    });

    it('sin comentario, la nota queda en null', async () => {
      await rejectApproval.execute('doc-1', REVIEWER_USER_ID);

      expect(managedCollaboratorRepository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ resolutionNote: null }),
      );
    });

    it('deja el documento REJECTED con su fecha de rechazo', async () => {
      const result = await rejectApproval.execute('doc-1', REVIEWER_USER_ID);

      expect(managedDocumentRepository.update).toHaveBeenCalledWith(
        { id: 'doc-1', status: DOCUMENT_STATUS_ENUM.PENDING_APPROVAL },
        expect.objectContaining({
          status: DOCUMENT_STATUS_ENUM.REJECTED,
          rejectedAt: expect.any(Date),
        }),
      );
      expect(result.data.status).toBe(DOCUMENT_STATUS_ENUM.REJECTED);
    });

    /** Criterio de aceptación: un documento rechazado no inicia el flujo de firma. */
    it('no arranca el flujo de firma ni notifica a los firmantes', async () => {
      await rejectApproval.execute('doc-1', REVIEWER_USER_ID);

      expect(documentService.notifyNextSigner).not.toHaveBeenCalled();
      expect(
        documentService.sendSimpleSignatureInvitations,
      ).not.toHaveBeenCalled();
      expect(documentEventsProducer.emitSentToSign).not.toHaveBeenCalled();
    });

    it('avisa al creador y publica document.approval_rejected con el motivo', async () => {
      await rejectApproval.execute(
        'doc-1',
        REVIEWER_USER_ID,
        'Falta el anexo B',
      );

      expect(
        documentService.notifyCreatorOfApprovalRejection,
      ).toHaveBeenCalledWith('doc-1', 'Falta el anexo B');
      expect(documentEventsProducer.enqueueApprovalEvent).toHaveBeenCalledWith(
        expect.anything(),
        DOCUMENT_KAFKA_TOPICS.APPROVAL_REJECTED,
        expect.objectContaining({ resolutionNote: 'Falta el anexo B' }),
      );
      expect(documentEventsProducer.flushOutbox).toHaveBeenCalled();
      expect(auditService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: AuditAction.DOCUMENT_APPROVAL_REJECTED,
        }),
      );
    });
  });
});
