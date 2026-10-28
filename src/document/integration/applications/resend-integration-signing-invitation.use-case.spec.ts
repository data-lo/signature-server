import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';
import {
  IntegrationInvitationNotResendableException,
  IntegrationSignerNotFoundException,
} from '../exceptions/integration-document.exceptions';
import { ResendIntegrationSigningInvitationUseCase } from './resend-integration-signing-invitation.use-case';

const API_CLIENT = {
  apiKeyId: 'key-1',
  apiKeyName: 'ERP',
  organizationId: 'org-1',
  actorAccountId: 'acc-actor',
  actorUserId: 'user-actor',
  permissions: [],
};
const METADATA = { ipAddress: '10.0.0.1', userAgent: 'erp/1.0' };

describe('ResendIntegrationSigningInvitationUseCase', () => {
  let document: Record<string, any> | null;
  let signers: Record<string, any>[];
  let documentRepository: { findOne: jest.Mock };
  let delivery: { deliver: jest.Mock };
  let useCase: ResendIntegrationSigningInvitationUseCase;

  beforeEach(() => {
    document = {
      id: 'd-1',
      organizationId: 'org-1',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      isSequential: true,
    };
    signers = [
      {
        id: 'c-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        status: COLLABORATOR_STATUS_ENUM.PENDING,
        signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
        signingOrder: 1,
        accountId: 'acc-prov',
        account: {
          user: { lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED },
        },
      },
      {
        id: 'c-2',
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        status: COLLABORATOR_STATUS_ENUM.PENDING,
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        signingOrder: 2,
        accountId: null,
        account: null,
      },
    ];
    documentRepository = { findOne: jest.fn(async () => document) };
    delivery = {
      deliver: jest.fn(async () => ({
        invitationId: 'inv-2',
        expiresAt: new Date('2026-11-26T00:00:00.000Z'),
        emailDelivered: true,
      })),
    };
    useCase = new ResendIntegrationSigningInvitationUseCase(
      documentRepository as never,
      { find: jest.fn(async () => signers) } as never,
      delivery as never,
    );
  });

  it('busca el documento sólo en la organización de la llave y reenvía con el apiKeyId en la auditoría', async () => {
    await expect(
      useCase.execute(API_CLIENT, 'd-1', 'c-1', METADATA),
    ).resolves.toEqual({
      success: true,
      message: 'Invitación reenviada al correo del firmante',
      data: {
        collaboratorId: 'c-1',
        invitationExpiresAt: new Date('2026-11-26T00:00:00.000Z'),
        emailDelivered: true,
      },
    });
    expect(documentRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'd-1', organizationId: 'org-1' },
    });
    expect(delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborator: signers[0],
        auditActor: {
          type: 'INTEGRATION_API_CLIENT',
          authMechanism: 'API_KEY',
          apiKeyId: 'key-1',
          userAgent: 'erp/1.0',
        },
        ipAddress: '10.0.0.1',
      }),
    );
  });

  it('la respuesta nunca lleva el enlace ni el token', async () => {
    const result = await useCase.execute(API_CLIENT, 'd-1', 'c-1', METADATA);
    expect(JSON.stringify(result)).not.toMatch(/sign\/|token|url/i);
  });

  it.each([
    ['el documento es de otra organización', () => (document = null)],
    ['el colaborador no es firmante del documento', () => (signers = [])],
  ])('404 si %s', async (_case, mutate) => {
    mutate();
    await expect(
      useCase.execute(API_CLIENT, 'd-1', 'c-1', METADATA),
    ).rejects.toBeInstanceOf(IntegrationSignerNotFoundException);
  });

  it.each([
    [
      'el documento ya no espera firmas',
      () => (document!.status = DOCUMENT_STATUS_ENUM.SIGNED),
      'c-1',
    ],
    [
      'el firmante ya respondió',
      () => (signers[0].status = COLLABORATOR_STATUS_ENUM.SIGNED),
      'c-1',
    ],
    ['todavía no es su turno', () => undefined, 'c-2'],
    [
      'firma desde su cuenta',
      () =>
        (signers[0].account.user.lifecycleStatus =
          USER_LIFECYCLE_STATUS_ENUM.ACTIVE),
      'c-1',
    ],
  ])('409 si %s', async (_case, mutate, collaboratorId) => {
    mutate();
    await expect(
      useCase.execute(API_CLIENT, 'd-1', collaboratorId, METADATA),
    ).rejects.toBeInstanceOf(IntegrationInvitationNotResendableException);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });
});
