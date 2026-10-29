import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';
import { SigningRateLimitException } from 'src/signing-invitation/signing-rate-limit.service';

import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import {
  IntegrationAmbiguousSignerException,
  IntegrationInvitationNotResendableException,
  IntegrationSignerNotFoundException,
  IntegrationSignerNotInTurnException,
} from '../exceptions/integration-document.exceptions';
import { IssueIntegrationSigningAccessUseCase } from './issue-integration-signing-access.use-case';

const API_CLIENT = {
  apiKeyId: 'key-1',
  apiKeyName: 'ERP',
  organizationId: 'org-1',
  actorAccountId: 'acc-actor',
  actorUserId: 'user-actor',
  permissions: [],
};
const METADATA = { ipAddress: '10.0.0.1', userAgent: 'erp/1.0' };

function provisionalSigner(
  id: string,
  email: string,
  order: number,
  signatureType = SIGNATURE_TYPE_ENUM.SIMPLE,
) {
  return {
    id,
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    status: COLLABORATOR_STATUS_ENUM.PENDING,
    signatureType,
    signingOrder: order,
    accountId: `acc-${id}`,
    email,
    account: {
      user: {
        email,
        lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
      },
    },
  };
}

describe('IssueIntegrationSigningAccessUseCase', () => {
  let document: Record<string, any> | null;
  let signers: Record<string, any>[];
  let documentRepository: { findOne: jest.Mock };
  let invitations: { ensureOpen: jest.Mock };
  let launches: { issue: jest.Mock };
  let limits: { consume: jest.Mock };
  let audit: { create: jest.Mock };
  let useCase: IssueIntegrationSigningAccessUseCase;

  beforeEach(() => {
    document = {
      id: 'd-1',
      organizationId: 'org-1',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      isSequential: true,
    };
    signers = [
      provisionalSigner('ana', 'ana@correo.com', 0),
      provisionalSigner('juan', 'juan@correo.com', 1),
    ];
    documentRepository = { findOne: jest.fn(async () => document) };
    invitations = { ensureOpen: jest.fn(async () => ({ id: 'inv-ana' })) };
    launches = {
      issue: jest.fn(async () => ({
        launch: { expiresAt: new Date('2026-10-27T19:05:00.000Z') },
        url: 'https://app.firmalo.mx/sign/launch/sla_x',
      })),
    };
    limits = { consume: jest.fn().mockResolvedValue(undefined) };
    audit = { create: jest.fn() };
    useCase = new IssueIntegrationSigningAccessUseCase(
      documentRepository as never,
      { find: jest.fn(async () => signers) } as never,
      invitations as never,
      launches as never,
      limits as never,
      audit as never,
    );
  });

  it('Ana (en turno): URL temporal de su invitación, buscada por correo normalizado y auditada con el apiKeyId', async () => {
    await expect(
      useCase.execute(API_CLIENT, 'd-1', '  Ana@Correo.com ', METADATA),
    ).resolves.toEqual({
      success: true,
      message: 'Acceso temporal de firma generado',
      data: {
        url: 'https://app.firmalo.mx/sign/launch/sla_x',
        expiresAt: new Date('2026-10-27T19:05:00.000Z'),
      },
    });
    expect(documentRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'd-1', organizationId: 'org-1' },
    });
    expect(invitations.ensureOpen).toHaveBeenCalledWith({
      documentId: 'd-1',
      collaboratorId: 'ana',
    });
    expect(launches.issue).toHaveBeenCalledWith({
      invitationId: 'inv-ana',
      apiKeyId: 'key-1',
      ipAddress: '10.0.0.1',
    });
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'SIGNING_LAUNCH_ISSUED',
        actor: expect.objectContaining({
          authMechanism: 'API_KEY',
          apiKeyId: 'key-1',
          invitationId: 'inv-ana',
          collaboratorId: 'ana',
          accessChannel: 'THIRD_PARTY_PORTAL',
        }),
      }),
    );
  });

  it('Juan antes de que Ana firme: 409 WAITING_FOR_PREVIOUS_SIGNER, sin token', async () => {
    await expect(
      useCase.execute(API_CLIENT, 'd-1', 'juan@correo.com', METADATA),
    ).rejects.toBeInstanceOf(IntegrationSignerNotInTurnException);
    expect(launches.issue).not.toHaveBeenCalled();
  });

  it('Juan después de que Ana firma: obtiene su acceso', async () => {
    signers[0].status = COLLABORATOR_STATUS_ENUM.SIGNED;
    await useCase.execute(API_CLIENT, 'd-1', 'juan@correo.com', METADATA);
    expect(invitations.ensureOpen).toHaveBeenCalledWith({
      documentId: 'd-1',
      collaboratorId: 'juan',
    });
  });

  it.each([
    ['el documento es de otra organización', () => (document = null)],
    ['ningún firmante tiene ese correo', () => undefined],
  ])('404 si %s', async (_case, mutate) => {
    mutate();
    await expect(
      useCase.execute(API_CLIENT, 'd-1', 'nadie@correo.com', METADATA),
    ).rejects.toBeInstanceOf(IntegrationSignerNotFoundException);
  });

  it('409 si dos firmantes comparten el correo', async () => {
    signers.push(provisionalSigner('ana-2', 'ana@correo.com', 2));
    await expect(
      useCase.execute(API_CLIENT, 'd-1', 'ana@correo.com', METADATA),
    ).rejects.toBeInstanceOf(IntegrationAmbiguousSignerException);
  });

  it.each([
    ['ya firmó', () => (signers[0].status = COLLABORATOR_STATUS_ENUM.SIGNED)],
    [
      'el documento se canceló',
      () => (document!.status = DOCUMENT_STATUS_ENUM.CANCELLED),
    ],
    [
      'firma desde su cuenta ACTIVE',
      () =>
        (signers[0].account.user.lifecycleStatus =
          USER_LIFECYCLE_STATUS_ENUM.ACTIVE),
    ],
  ])('409 si el firmante %s', async (_case, mutate) => {
    mutate();
    await expect(
      useCase.execute(API_CLIENT, 'd-1', 'ana@correo.com', METADATA),
    ).rejects.toBeInstanceOf(IntegrationInvitationNotResendableException);
  });

  it('429 con demasiados accesos para el firmante, sin emitir', async () => {
    limits.consume.mockRejectedValue(new SigningRateLimitException());
    await expect(
      useCase.execute(API_CLIENT, 'd-1', 'ana@correo.com', METADATA),
    ).rejects.toBeInstanceOf(SigningRateLimitException);
    expect(launches.issue).not.toHaveBeenCalled();
  });
});
