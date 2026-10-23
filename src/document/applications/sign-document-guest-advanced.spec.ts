import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { VERIFICATION_EVENT_ENUM } from '../enum/verification-event.enum';
import { SIGNING_AUTHORIZATION_ENUM } from '../enum/signing-authorization.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from '../enum/guest-signing-access-purpose.enum';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { hashInvitationEmail } from '../services/guest-signing-access.service';
import {
  GuestAdvancedInvitationNotFoundException,
  InvalidGuestSigningAccessException,
} from '../exceptions/guest-signing-access.exceptions';
import {
  GuestAdvancedSignatureRequest,
  SignDocumentUseCase,
} from './sign-document.use-case';

const GEO = { latitude: 19.43, longitude: -99.13 };
const HASH = 'a'.repeat(64);
const EFIRMA_RESULT = { signatureBase64: 'c2ln', algorithm: 'sha256' };

/**
 * Firma Avanzada del invitado sin cuenta (`executeGuestAdvanced`). Lo que fija: el acceso temporal
 * es lo único que autoriza la firma, se revalida todo justo antes de firmar, y el claim —consumir
 * el acceso y marcar SIGNED a un colaborador que siga sin cuenta— es atómico.
 */
describe('SignDocumentUseCase — Firma Avanzada de invitado sin cuenta', () => {
  let signer: Record<string, unknown>;
  let access: Record<string, unknown>;
  let document: Record<string, unknown>;
  let collaboratorRepository: {
    update: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let txCollaborators: { update: jest.Mock };
  let txAccesses: { update: jest.Mock };
  let documentService: Record<string, jest.Mock>;
  let accesses: Record<string, jest.Mock>;
  let producer: { emitSigned: jest.Mock; emitCollaboratorSigned: jest.Mock };
  let audit: { create: jest.Mock };
  let hasConsumedCode: jest.Mock;
  let useCase: SignDocumentUseCase;

  const request = (
    overrides: Partial<GuestAdvancedSignatureRequest> = {},
  ): GuestAdvancedSignatureRequest => ({
    accessId: 'acc-1',
    documentId: 'd-1',
    collaboratorId: 'c-1',
    documentHash: HASH,
    advancedSignatureInput: { password: 'secreta' },
    geolocation: GEO,
    ipAddress: '10.0.0.9',
    ...overrides,
  });

  beforeEach(() => {
    signer = {
      id: 'c-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      signatureType: SIGNATURE_TYPE_ENUM.FIEL,
      signingOrder: 1,
      accountId: null,
      account: null,
      email: 'Ana@Correo.mx',
    };
    access = {
      id: 'acc-1',
      documentId: 'd-1',
      collaboratorId: 'c-1',
      purpose:
        GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
      emailHash: hashInvitationEmail('ana@correo.mx'),
    };
    document = {
      id: 'd-1',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      originalHash: HASH,
      isSequential: true,
      requiresVerification: false,
      fileName: 'contrato.pdf',
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
      validateAndSignWithEfirma: jest.fn(async () => EFIRMA_RESULT),
      snapshotSignatureImage: jest.fn(),
      finalizeSignedDocument: jest.fn().mockResolvedValue(undefined),
      refreshPartiallySignedPreview: jest.fn(),
      notifyNextSigner: jest.fn(),
    };
    accesses = {
      findActive: jest.fn(async () => access),
      consume: jest.fn().mockResolvedValue(true),
      revokeOpenForCollaborator: jest.fn().mockResolvedValue(0),
      revokeOpenForDocument: jest.fn().mockResolvedValue(0),
    };
    producer = { emitSigned: jest.fn(), emitCollaboratorSigned: jest.fn() };
    audit = { create: jest.fn() };
    hasConsumedCode = jest.fn().mockResolvedValue(true);

    useCase = new SignDocumentUseCase(
      { update: jest.fn() } as never,
      collaboratorRepository as never,
      { findOne: jest.fn() } as never,
      audit as never,
      producer as never,
      { hasConsumedCode } as never,
      documentService as never,
      { assertCanSign: jest.fn() } as never,
      accesses as never,
    );
  });

  it('firma sin cuenta: consume el acceso y marca SIGNED en una transacción, sólo si sigue sin cuenta', async () => {
    const result = await useCase.executeGuestAdvanced(request());

    expect(accesses.consume).toHaveBeenCalledWith(expect.anything(), 'acc-1');
    expect(txCollaborators.update).toHaveBeenCalledWith(
      {
        id: 'c-1',
        status: COLLABORATOR_STATUS_ENUM.PENDING,
        accountId: IsNull(),
      },
      expect.objectContaining({
        status: COLLABORATOR_STATUS_ENUM.SIGNED,
        signingAuthorization: SIGNING_AUTHORIZATION_ENUM.GUEST_EMAIL_OTP,
      }),
    );
    // Revoca los demás accesos abiertos del colaborador dentro de la misma transacción.
    expect(txAccesses.update).toHaveBeenCalledWith(
      expect.objectContaining({
        collaboratorId: 'c-1',
        consumedAt: IsNull(),
        revokedAt: IsNull(),
      }),
      expect.objectContaining({ revokedAt: expect.any(Date) }),
    );
    // El claim fuera de transacción (el de la firma con cuenta) no corre.
    expect(collaboratorRepository.update).not.toHaveBeenCalled();
    expect(result.data).toEqual({ id: 'd-1', documentCompleted: true });
  });

  it('guarda la evidencia (firma avanzada, IP, ubicación, autorización) sin secretos', async () => {
    await useCase.executeGuestAdvanced(request());

    const saved = collaboratorRepository.save.mock.calls[0][0];
    expect(saved).toEqual(
      expect.objectContaining({
        advancedSignature: EFIRMA_RESULT,
        ipAddress: '10.0.0.9',
        geolocation: GEO,
        signingAuthorization: SIGNING_AUTHORIZATION_ENUM.GUEST_EMAIL_OTP,
      }),
    );
    expect(JSON.stringify(saved)).not.toContain('secreta');
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [expect.objectContaining({ userId: 'guest-collaborator:c-1' })],
      }),
    );
  });

  it('la auditoría registra firmante, documento, fecha, IP y el método de validación sin cuenta', async () => {
    await useCase.executeGuestAdvanced(request());

    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'd-1',
        ipAddress: '10.0.0.9',
        signedAt: expect.any(Date),
        geolocation: GEO,
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        signingAuthorization: SIGNING_AUTHORIZATION_ENUM.GUEST_EMAIL_OTP,
      }),
    );
  });

  it('si era el último firmante, finaliza el documento y revoca todos sus accesos', async () => {
    await useCase.executeGuestAdvanced(request());

    expect(documentService.finalizeSignedDocument).toHaveBeenCalled();
    expect(accesses.revokeOpenForDocument).toHaveBeenCalledWith('d-1');
  });

  it.each([
    ['no existe o ya no está activo (vencido, revocado o consumido)', null],
    ['es de otro documento', { documentId: 'd-2' }],
    ['es de otro colaborador', { collaboratorId: 'c-2' }],
  ])(
    'rechaza un acceso que %s, sin tocar la e.firma',
    async (_case, override) => {
      accesses.findActive.mockResolvedValue(
        override === null ? null : { ...access, ...override },
      );

      await expect(useCase.executeGuestAdvanced(request())).rejects.toThrow(
        InvalidGuestSigningAccessException,
      );
      expect(documentService.validateAndSignWithEfirma).not.toHaveBeenCalled();
    },
  );

  it('no firma si el colaborador ya vinculó una cuenta: debe firmar desde su dashboard', async () => {
    Object.assign(signer, {
      accountId: 'acc-personal',
      account: { userId: 'u-1' },
    });

    await expect(useCase.executeGuestAdvanced(request())).rejects.toThrow(
      GuestAdvancedInvitationNotFoundException,
    );
    expect(documentService.validateAndSignWithEfirma).not.toHaveBeenCalled();
  });

  it('no firma si la invitación cambió de correo después de emitir el acceso', async () => {
    signer.email = 'otra@correo.mx';

    await expect(useCase.executeGuestAdvanced(request())).rejects.toThrow(
      GuestAdvancedInvitationNotFoundException,
    );
  });

  it('no firma si el colaborador no es de Firma Avanzada', async () => {
    signer.signatureType = SIGNATURE_TYPE_ENUM.SIMPLE;

    await expect(useCase.executeGuestAdvanced(request())).rejects.toThrow(
      GuestAdvancedInvitationNotFoundException,
    );
  });

  it('no firma si el documento cambió desde que el invitado lo revisó', async () => {
    await expect(
      useCase.executeGuestAdvanced(request({ documentHash: 'b'.repeat(64) })),
    ).rejects.toThrow(BadRequestException);
    expect(documentService.validateAndSignWithEfirma).not.toHaveBeenCalled();
  });

  it('no firma si el documento ya no está pendiente', async () => {
    document.status = DOCUMENT_STATUS_ENUM.REJECTED;

    await expect(useCase.executeGuestAdvanced(request())).rejects.toThrow(
      BadRequestException,
    );
  });

  it('no firma fuera de turno', async () => {
    const first = {
      ...signer,
      id: 'c-0',
      signingOrder: 1,
      email: 'primero@correo.mx',
    };
    signer.signingOrder = 2;
    collaboratorRepository.find.mockResolvedValue([first, signer]);

    await expect(useCase.executeGuestAdvanced(request())).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('exige la geolocalización', async () => {
    await expect(
      useCase.executeGuestAdvanced(request({ geolocation: undefined })),
    ).rejects.toThrow(BadRequestException);
    expect(accesses.findActive).not.toHaveBeenCalled();
  });

  it('una e.firma inválida no gasta el acceso', async () => {
    documentService.validateAndSignWithEfirma.mockRejectedValue(
      new BadRequestException('Contraseña incorrecta'),
    );

    await expect(useCase.executeGuestAdvanced(request())).rejects.toThrow(
      'Contraseña incorrecta',
    );
    expect(accesses.consume).not.toHaveBeenCalled();
  });

  it('si otra petición consumió el acceso primero, no registra la firma', async () => {
    accesses.consume.mockResolvedValue(false);

    await expect(useCase.executeGuestAdvanced(request())).rejects.toThrow(
      InvalidGuestSigningAccessException,
    );
    expect(txCollaborators.update).not.toHaveBeenCalled();
    expect(collaboratorRepository.save).not.toHaveBeenCalled();
  });

  it('si entre medias se vinculó una cuenta o firmó por el dashboard, el claim falla y nada se registra', async () => {
    txCollaborators.update.mockResolvedValue({ affected: 0 });

    await expect(useCase.executeGuestAdvanced(request())).rejects.toThrow(
      BadRequestException,
    );
    expect(collaboratorRepository.save).not.toHaveBeenCalled();
    expect(producer.emitCollaboratorSigned).not.toHaveBeenCalled();
  });

  it('si el documento exige código, cuenta el de acceso de invitado a Firma Avanzada', async () => {
    document.requiresVerification = true;

    await useCase.executeGuestAdvanced(request());

    expect(hasConsumedCode).toHaveBeenCalledWith(
      'd-1',
      'c-1',
      VERIFICATION_EVENT_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
    );
  });

  it('el token de un invitado no sirve en la ruta privada: un FIEL con cuenta firma con ACCOUNT_SESSION', async () => {
    Object.assign(signer, {
      accountId: 'acc-personal',
      account: { userId: 'u-1', user: { id: 'u-1' } },
    });
    documentService.findOrLinkMySignerCollaborator = jest.fn(async () => ({
      signerCollaborators: [signer],
      myParticipant: signer,
    }));

    await useCase.execute('d-1', 'u-1', { password: 'x' }, GEO);

    expect(collaboratorRepository.update).toHaveBeenCalledWith(
      { id: 'c-1', status: COLLABORATOR_STATUS_ENUM.PENDING },
      expect.objectContaining({
        signingAuthorization: SIGNING_AUTHORIZATION_ENUM.ACCOUNT_SESSION,
      }),
    );
    expect(accesses.revokeOpenForCollaborator).toHaveBeenCalledWith(
      'c-1',
      GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
    );
    expect(collaboratorRepository.manager.transaction).not.toHaveBeenCalled();
  });

  it('la firma FIEL con cuenta audita ACCOUNT_SESSION con la IP de la petición', async () => {
    Object.assign(signer, {
      accountId: 'acc-personal',
      account: { userId: 'u-1', user: { id: 'u-1' } },
    });
    documentService.findOrLinkMySignerCollaborator = jest.fn(async () => ({
      signerCollaborators: [signer],
      myParticipant: signer,
    }));

    await useCase.execute(
      'd-1',
      'u-1',
      { password: 'x' },
      GEO,
      undefined,
      '10.0.0.4',
    );

    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ipAddress: '10.0.0.4',
        users: [expect.objectContaining({ userId: 'u-1' })],
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        signingAuthorization: SIGNING_AUTHORIZATION_ENUM.ACCOUNT_SESSION,
      }),
    );
    expect(collaboratorRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '10.0.0.4' }),
    );
  });

  it('sin IP conocida, la firma con cuenta audita la IP del documento como antes', async () => {
    Object.assign(signer, {
      accountId: 'acc-personal',
      account: { userId: 'u-1', user: { id: 'u-1' } },
    });
    document.ipAddress = '192.168.0.1';
    documentService.findOrLinkMySignerCollaborator = jest.fn(async () => ({
      signerCollaborators: [signer],
      myParticipant: signer,
    }));

    await useCase.execute('d-1', 'u-1', { password: 'x' }, GEO);

    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '192.168.0.1' }),
    );
  });

  it('un fallo al revocar no deshace una firma ya registrada', async () => {
    accesses.revokeOpenForDocument.mockRejectedValue(new Error('db caída'));

    const result = await useCase.executeGuestAdvanced(request());

    expect(result.success).toBe(true);
  });
});
