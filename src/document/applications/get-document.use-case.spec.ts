import { GetDocumentUseCase } from './get-document.use-case';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import type { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';

/**
 * Historia "Actualizar estado de testigo a 'Notificado' al consultar el documento": el detalle es
 * de donde el frontend lee el estatus de cada participante, así que tiene que devolver el que está
 * guardado —`NOTIFIED` una vez enviado el aviso, `PENDING` mientras no— sin traducirlo ni tocar
 * el de los demás.
 */
describe('GetDocumentUseCase: estatus de los participantes', () => {
  const authorization = { userId: 'creator-1' } as AuthorizationContext;

  function buildCollaborator(overrides: Record<string, unknown>) {
    return {
      id: 'collaborator',
      accountId: null,
      account: null,
      email: 'persona@correo.com',
      firstName: 'Persona',
      lastName: 'Uno',
      signingOrder: null,
      cancellationReason: null,
      resolvedAt: null,
      signatureType: null,
      ...overrides,
    };
  }

  function buildUseCase(collaborators: unknown[]) {
    const documentRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'doc-1',
        fileName: 'contrato.pdf',
        fileType: 'application/pdf',
        totalPages: 1,
        status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
        createdBy: 'creator-1',
        requestedBy: { firstName: 'Creador', lastName: 'Uno' },
        objectKey: 'object-1',
        isSequential: true,
        requiresVerification: false,
        isIndexable: true,
        totalSigners: 1,
        completedSignersCount: 0,
        signedAt: null,
        collaborators,
      }),
    };
    const minioService = {
      getFile: jest
        .fn()
        .mockResolvedValue({ secureUrl: 'https://minio/doc', expiresIn: 60 }),
    };
    const documentTransactionService = {
      findAllForDocument: jest.fn().mockResolvedValue([]),
    };
    const verificationCodeService = { hasConsumedCode: jest.fn() };
    const documentService = {
      resolveMyCollaborator: jest.fn().mockResolvedValue(undefined),
      resolveDocumentBucket: jest.fn().mockReturnValue('bucket'),
    };
    const readAccess = {
      assertCanRead: jest.fn().mockResolvedValue(undefined),
    };

    return new GetDocumentUseCase(
      documentRepository as never,
      minioService as never,
      documentTransactionService as never,
      verificationCodeService as never,
      documentService as never,
      readAccess as never,
    );
  }

  function statusOf(
    participants: { id: string; status: string }[],
    id: string,
  ) {
    return participants.find((participant) => participant.id === id)?.status;
  }

  it('expone NOTIFIED para el testigo al que ya se le envió el aviso', async () => {
    const useCase = buildUseCase([
      buildCollaborator({
        id: 'witness-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS,
        status: COLLABORATOR_STATUS_ENUM.NOTIFIED,
      }),
    ]);

    const { data } = await useCase.execute({
      documentId: 'doc-1',
      authorization,
    });

    expect(statusOf(data.participants, 'witness-1')).toBe(
      COLLABORATOR_STATUS_ENUM.NOTIFIED,
    );
  });

  it('expone PENDING para el testigo que todavía no fue notificado (o cuyo correo falló)', async () => {
    const useCase = buildUseCase([
      buildCollaborator({
        id: 'witness-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS,
        status: COLLABORATOR_STATUS_ENUM.PENDING,
      }),
    ]);

    const { data } = await useCase.execute({
      documentId: 'doc-1',
      authorization,
    });

    expect(statusOf(data.participants, 'witness-1')).toBe(
      COLLABORATOR_STATUS_ENUM.PENDING,
    );
  });

  it('devuelve el estatus de firmantes y aprobadores tal como está, junto al testigo notificado', async () => {
    const useCase = buildUseCase([
      buildCollaborator({
        id: 'signer-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        status: COLLABORATOR_STATUS_ENUM.PENDING,
        signingOrder: 0,
      }),
      buildCollaborator({
        id: 'reviewer-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.REVIEWER,
        status: COLLABORATOR_STATUS_ENUM.APPROVED,
      }),
      buildCollaborator({
        id: 'witness-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.WITNESS,
        status: COLLABORATOR_STATUS_ENUM.NOTIFIED,
      }),
    ]);

    const { data } = await useCase.execute({
      documentId: 'doc-1',
      authorization,
    });

    expect(statusOf(data.participants, 'signer-1')).toBe(
      COLLABORATOR_STATUS_ENUM.PENDING,
    );
    expect(statusOf(data.participants, 'reviewer-1')).toBe(
      COLLABORATOR_STATUS_ENUM.APPROVED,
    );
    expect(statusOf(data.participants, 'witness-1')).toBe(
      COLLABORATOR_STATUS_ENUM.NOTIFIED,
    );
  });
});
