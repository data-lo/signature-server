import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { AUDIT_AUTH_MECHANISM_ENUM } from 'src/audit/schema/audit-document';

import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from '../enum/guest-signing-access-purpose.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { SIGNING_AUTHORIZATION_ENUM } from '../enum/signing-authorization.enum';
import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';
import { InvalidGuestSigningAccessException } from '../exceptions/guest-signing-access.exceptions';
import {
  PublicInvitationSigningActor,
  signingActorReference,
} from '../interfaces/signing-actor.interface';
import { SignDocumentUseCase, toAuditActor } from './sign-document.use-case';

const GEO = { latitude: 19.43, longitude: -99.13 };
const HASH = 'b'.repeat(64);
const METADATA = { ipAddress: '10.0.0.9', userAgent: 'Mozilla/5.0' };

/**
 * `SignDocumentUseCase.sign` con los dos actores. Lo que fija: la firma es la misma; cambia cómo se
 * resuelve el colaborador, qué código se exige y qué evidencia queda. La ruta autenticada
 * (`execute`) sigue resolviendo al firmante por su usuario, sin depender del request.
 */
describe('SignDocumentUseCase — firma por SigningActor', () => {
  let signer: Record<string, any>;
  let document: Record<string, any>;
  let collaboratorRepository: Record<string, any>;
  let txCollaborators: { update: jest.Mock };
  let txAccesses: { update: jest.Mock };
  let documentService: Record<string, jest.Mock>;
  let accesses: Record<string, jest.Mock>;
  let audit: { create: jest.Mock };
  let hasConsumedCode: jest.Mock;
  let assertCanSign: jest.Mock;
  let useCase: SignDocumentUseCase;

  const publicActor = (
    overrides: Partial<PublicInvitationSigningActor> = {},
  ): PublicInvitationSigningActor => ({
    type: 'PUBLIC_INVITATION',
    invitationId: 'inv-1',
    collaboratorId: 'c-1',
    userId: 'user-prov',
    accountId: 'acc-prov',
    organizationId: 'org-1',
    sessionAccessId: 'session-1',
    verifiedEmail: true,
    ...overrides,
  });

  beforeEach(() => {
    signer = {
      id: 'c-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
      signingOrder: 1,
      accountId: 'acc-prov',
      account: { user: { id: 'user-prov' } },
    };
    document = {
      id: 'd-1',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      originalHash: HASH,
      isSequential: true,
      requiresVerification: true,
      fileName: 'contrato.pdf',
      completedSignersCount: 0,
    };

    txCollaborators = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    txAccesses = { update: jest.fn().mockResolvedValue({ affected: 0 }) };
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === CollaboratorEntity ? txCollaborators : txAccesses,
      ),
    };
    collaboratorRepository = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn().mockResolvedValue(undefined),
      find: jest.fn(async () => [signer]),
      manager: {
        transaction: jest.fn(async (work: (m: unknown) => unknown) =>
          work(manager),
        ),
      },
    };
    documentService = {
      findOne: jest.fn(async () => document),
      findOrLinkMySignerCollaborator: jest.fn(async () => ({
        signerCollaborators: [signer],
        myParticipant: signer,
      })),
      validateAndSignWithEfirma: jest.fn(async () => ({ signature: 'x' })),
      assertCanSignWithSimpleSignature: jest.fn(),
      snapshotSignatureImage: jest.fn(async () => 'snapshots/c-1.png'),
      finalizeSignedDocument: jest.fn().mockResolvedValue(undefined),
      refreshPartiallySignedPreview: jest.fn(),
      notifyNextSigner: jest.fn(),
    };
    accesses = {
      consume: jest.fn().mockResolvedValue(true),
      revokeOpenForCollaborator: jest.fn().mockResolvedValue(0),
      revokeOpenForDocument: jest.fn().mockResolvedValue(0),
    };
    audit = { create: jest.fn() };
    hasConsumedCode = jest.fn().mockResolvedValue(true);
    assertCanSign = jest.fn();

    useCase = new SignDocumentUseCase(
      { update: jest.fn() } as never,
      collaboratorRepository as never,
      { findOne: jest.fn() } as never,
      audit as never,
      { emitSigned: jest.fn(), emitCollaboratorSigned: jest.fn() } as never,
      { hasConsumedCode } as never,
      documentService as never,
      { assertCanSign } as never,
      accesses as never,
    );
  });

  describe('PUBLIC_INVITATION', () => {
    it('firma simple: colaborador de la invitación, código de la sesión y consumo del acceso con la cuenta provisional', async () => {
      const result = await useCase.sign(
        publicActor(),
        {
          documentId: 'd-1',
          geolocation: GEO,
          documentHash: HASH,
          metadata: METADATA,
        },
        SIGNATURE_TYPE_ENUM.SIMPLE,
      );

      expect(result.data).toEqual({ id: 'd-1', documentCompleted: true });
      // No resuelve por usuario ni vincula: el colaborador es el de la invitación.
      expect(
        documentService.findOrLinkMySignerCollaborator,
      ).not.toHaveBeenCalled();
      expect(hasConsumedCode).toHaveBeenCalledWith(
        'd-1',
        'c-1',
        VERIFICATION_EVENT_ENUM.PUBLIC_SIGNING_ACCESS,
      );
      expect(accesses.consume).toHaveBeenCalledWith(
        expect.anything(),
        'session-1',
      );
      expect(txCollaborators.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c-1', accountId: 'acc-prov' }),
        expect.objectContaining({
          status: COLLABORATOR_STATUS_ENUM.SIGNED,
          signingAuthorization: SIGNING_AUTHORIZATION_ENUM.GUEST_EMAIL_OTP,
        }),
      );
      expect(documentService.snapshotSignatureImage).toHaveBeenCalled();
      // Firmado: se revocan en la misma transacción los demás accesos del colaborador.
      expect(txAccesses.update).toHaveBeenCalledWith(
        expect.objectContaining({
          collaboratorId: 'c-1',
          purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION,
        }),
        { revokedAt: expect.any(Date) },
      );
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '10.0.0.9',
          users: [{ userId: 'user-prov', action: 'DOCUMENT_SIGNED' }],
          actor: {
            type: 'PUBLIC_INVITATION',
            authMechanism: AUDIT_AUTH_MECHANISM_ENUM.PUBLIC_SIGNING_SESSION,
            invitationId: 'inv-1',
            collaboratorId: 'c-1',
            userAgent: 'Mozilla/5.0',
          },
          result: 'SUCCESS',
        }),
      );
    });

    it('firma avanzada sin cuenta: consume el acceso exigiendo que siga sin cuenta', async () => {
      signer.signatureType = SIGNATURE_TYPE_ENUM.FIEL;
      signer.accountId = null;
      signer.account = null;

      await useCase.sign(
        publicActor({ userId: undefined, accountId: undefined }),
        {
          documentId: 'd-1',
          geolocation: GEO,
          documentHash: HASH,
          advancedSignatureInput: { password: 'x' },
          metadata: METADATA,
        },
        SIGNATURE_TYPE_ENUM.FIEL,
      );

      expect(documentService.validateAndSignWithEfirma).toHaveBeenCalled();
      const [where] = txCollaborators.update.mock.calls[0];
      expect(where.accountId).not.toBe('acc-prov');
      expect(where.accountId).toEqual(
        expect.objectContaining({ _type: 'isNull' }),
      );
    });

    it('el tipo lo decide el documento: una ruta de otro tipo se rechaza antes de firmar', async () => {
      await expect(
        useCase.sign(
          publicActor(),
          {
            documentId: 'd-1',
            geolocation: GEO,
            documentHash: HASH,
            metadata: METADATA,
          },
          SIGNATURE_TYPE_ENUM.FIEL,
        ),
      ).rejects.toThrow('Este documento no se firma con este tipo de firma.');
      expect(accesses.consume).not.toHaveBeenCalled();
    });

    it('rechaza si el PDF cambió desde que lo revisó', async () => {
      await expect(
        useCase.sign(
          publicActor(),
          {
            documentId: 'd-1',
            geolocation: GEO,
            documentHash: 'c'.repeat(64),
            metadata: METADATA,
          },
          SIGNATURE_TYPE_ENUM.SIMPLE,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza si el colaborador se vinculó a otra cuenta después de abrir la sesión', async () => {
      signer.accountId = 'acc-otra';
      await expect(
        useCase.sign(
          publicActor(),
          {
            documentId: 'd-1',
            geolocation: GEO,
            documentHash: HASH,
            metadata: METADATA,
          },
          SIGNATURE_TYPE_ENUM.SIMPLE,
        ),
      ).rejects.toBeInstanceOf(InvalidGuestSigningAccessException);
    });

    it('403 si el colaborador de la sesión ya no es firmante del documento', async () => {
      collaboratorRepository.find.mockResolvedValue([]);
      await expect(
        useCase.sign(publicActor(), {
          documentId: 'd-1',
          geolocation: GEO,
          documentHash: HASH,
          metadata: METADATA,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('exige el código de la sesión, no el de firma de la plataforma', async () => {
      hasConsumedCode.mockResolvedValue(false);
      await expect(
        useCase.sign(publicActor(), {
          documentId: 'd-1',
          geolocation: GEO,
          documentHash: HASH,
          metadata: METADATA,
        }),
      ).rejects.toThrow(/requiere verificación/);
      expect(hasConsumedCode).toHaveBeenCalledWith(
        'd-1',
        'c-1',
        VERIFICATION_EVENT_ENUM.PUBLIC_SIGNING_ACCESS,
      );
    });
  });

  describe('AUTHENTICATED_ACCOUNT (ruta autenticada sin regresiones)', () => {
    const authorization = {
      userId: 'user-1',
      accountId: 'acc-1',
      organizationId: 'org-1',
    } as never;

    beforeEach(() => {
      signer.accountId = 'acc-1';
      signer.account = { user: { id: 'user-1' } };
    });

    it('execute arma el actor desde el JWT y resuelve al firmante por su usuario', async () => {
      await useCase.execute(
        'd-1',
        'user-1',
        undefined,
        GEO,
        authorization,
        '10.0.0.1',
        'Mozilla/5.0',
      );

      expect(
        documentService.findOrLinkMySignerCollaborator,
      ).toHaveBeenCalledWith('d-1', 'user-1', expect.anything());
      expect(assertCanSign).toHaveBeenCalledWith(
        expect.objectContaining({ authorization, participant: signer }),
      );
      expect(hasConsumedCode).toHaveBeenCalledWith(
        'd-1',
        'c-1',
        VERIFICATION_EVENT_ENUM.SIGN_DOCUMENT,
      );
      expect(accesses.consume).not.toHaveBeenCalled();
      expect(collaboratorRepository.update).toHaveBeenCalledWith(
        { id: 'c-1', status: COLLABORATOR_STATUS_ENUM.PENDING },
        expect.objectContaining({
          signingAuthorization: SIGNING_AUTHORIZATION_ENUM.ACCOUNT_SESSION,
        }),
      );
      // Firmar con la cuenta cierra también una sesión pública abierta para la misma invitación.
      expect(accesses.revokeOpenForCollaborator).toHaveBeenCalledWith(
        'c-1',
        GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION,
      );
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: {
            type: 'AUTHENTICATED_ACCOUNT',
            authMechanism: AUDIT_AUTH_MECHANISM_ENUM.JWT,
            userAgent: 'Mozilla/5.0',
          },
        }),
      );
    });

    it('no exige el hash del PDF (la ruta autenticada nunca lo pidió)', async () => {
      await expect(
        useCase.execute('d-1', 'user-1', undefined, GEO, authorization),
      ).resolves.toEqual(expect.objectContaining({ success: true }));
    });

    it('sigue respondiendo 403 a quien no es firmante', async () => {
      documentService.findOrLinkMySignerCollaborator.mockResolvedValue({
        signerCollaborators: [signer],
        myParticipant: null,
      });
      await expect(
        useCase.execute('d-1', 'user-9', undefined, GEO, authorization),
      ).rejects.toThrow('No eres firmante de este documento');
    });
  });

  it('signingActorReference y toAuditActor nunca llevan token ni código', () => {
    const actor = publicActor({ userId: undefined });
    expect(signingActorReference(actor)).toBe('public-invitation:c-1');
    expect(JSON.stringify(toAuditActor(actor, null))).not.toMatch(
      /session-1|token|code/,
    );
  });
});
