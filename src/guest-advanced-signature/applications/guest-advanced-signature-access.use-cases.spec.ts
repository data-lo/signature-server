import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { VERIFICATION_EVENT_ENUM } from 'src/document/enum/verification-event.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from 'src/document/enum/guest-signing-access-purpose.enum';
import { GuestAdvancedInvitationNotFoundException } from 'src/document/exceptions/guest-signing-access.exceptions';
import { GuestAdvancedSignerService } from '../services/guest-advanced-signer.service';
import {
  GUEST_ADVANCED_ACCESS_TTL_SECONDS,
  GuestAdvancedSignatureAccessUseCases,
} from './guest-advanced-signature-access.use-cases';

const PURPOSE =
  GUEST_SIGNING_ACCESS_PURPOSE_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS;

/**
 * Acceso del invitado sin cuenta a su Firma Avanzada, con el `GuestAdvancedSignerService` real
 * para que las reglas de la invitación (FIEL, sin cuenta, correo, estado, turno) se prueben de
 * verdad y no a través de un mock.
 */
describe('GuestAdvancedSignatureAccessUseCases', () => {
  let signer: Record<string, unknown>;
  let document: Record<string, unknown>;
  let collaborators: { find: jest.Mock };
  let verificationCodes: { issue: jest.Mock; verifyAndConsume: jest.Mock };
  let accesses: { issue: jest.Mock };
  let tokens: { issue: jest.Mock };
  let email: { sendVerificationCodeNotification: jest.Mock };
  let documentService: { findOne: jest.Mock; getDocumentMinioURL: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let useCases: GuestAdvancedSignatureAccessUseCases;
  const manager = { name: 'tx' };

  beforeEach(() => {
    signer = {
      id: 'c-1',
      colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      signatureType: SIGNATURE_TYPE_ENUM.FIEL,
      signingOrder: 1,
      accountId: null,
      email: 'ana@correo.mx',
    };
    document = {
      id: 'd-1',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      isSequential: true,
      fileName: 'contrato.pdf',
      originalHash: 'f'.repeat(64),
    };
    collaborators = { find: jest.fn(async () => [signer]) };
    verificationCodes = {
      issue: jest.fn(async () => ({ code: '123456' })),
      verifyAndConsume: jest.fn().mockResolvedValue(undefined),
    };
    accesses = { issue: jest.fn(async () => ({ id: 'acc-1' })) };
    tokens = {
      issue: jest.fn(() => ({ accessToken: 'tok', expiresAt: new Date() })),
    };
    email = { sendVerificationCodeNotification: jest.fn() };
    documentService = {
      findOne: jest.fn(async () => document),
      getDocumentMinioURL: jest.fn(async () => ({
        secureUrl: 'https://minio/doc.pdf',
        expiresIn: 300,
      })),
    };
    dataSource = {
      transaction: jest.fn(async (work: (m: unknown) => unknown) =>
        work(manager),
      ),
    };

    useCases = new GuestAdvancedSignatureAccessUseCases(
      dataSource as never,
      new GuestAdvancedSignerService(
        collaborators as never,
        documentService as never,
      ),
      verificationCodes as never,
      accesses as never,
      tokens as never,
      email as never,
      documentService as never,
    );
  });

  describe('checkInvitation', () => {
    it('admite a un firmante FIEL sin cuenta con ese correo (sin distinguir mayúsculas)', async () => {
      await expect(
        useCases.checkInvitation('d-1', 'c-1', ' ANA@correo.mx '),
      ).resolves.toEqual({ guestAdvancedSignature: true });
    });

    it.each([
      ['otro correo', () => undefined, 'otra@correo.mx'],
      ['cuenta vinculada', () => (signer.accountId = 'acc-9'), 'ana@correo.mx'],
      [
        'firma no avanzada',
        () => (signer.signatureType = SIGNATURE_TYPE_ENUM.BIOMETRIC),
        'ana@correo.mx',
      ],
    ])(
      'responde false con %s, sin decir por qué',
      async (_case, mutate, mail) => {
        mutate();
        await expect(
          useCases.checkInvitation('d-1', 'c-1', mail),
        ).resolves.toEqual({
          guestAdvancedSignature: false,
        });
      },
    );
  });

  describe('requestCode', () => {
    it('emite el código GUEST_ADVANCED_SIGNATURE_ACCESS y lo manda al correo GUARDADO', async () => {
      signer.email = 'Ana@Correo.mx';

      const result = await useCases.requestCode(
        'd-1',
        'c-1',
        'ana@correo.mx',
        '10.0.0.1',
      );

      expect(verificationCodes.issue).toHaveBeenCalledWith(
        'd-1',
        'c-1',
        VERIFICATION_EVENT_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
        '10.0.0.1',
      );
      expect(email.sendVerificationCodeNotification).toHaveBeenCalledWith(
        'Ana@Correo.mx',
        'contrato.pdf',
        '123456',
      );
      expect(result).toEqual({ emailDelivered: true });
    });

    it('sin correo en la petición (pantalla pública /sign) identifica la invitación por el colaborador', async () => {
      const result = await useCases.requestCode('d-1', 'c-1', null, '10.0.0.1');

      expect(email.sendVerificationCodeNotification).toHaveBeenCalledWith(
        'ana@correo.mx',
        'contrato.pdf',
        '123456',
      );
      expect(result).toEqual({ emailDelivered: true });
    });

    it('si el correo viene y no coincide, no emite código', async () => {
      await expect(
        useCases.requestCode('d-1', 'c-1', 'otra@correo.mx', null),
      ).rejects.toThrow(GuestAdvancedInvitationNotFoundException);
      expect(verificationCodes.issue).not.toHaveBeenCalled();
    });

    it('no emite código si el documento no está pendiente de firma', async () => {
      document.status = DOCUMENT_STATUS_ENUM.PENDING_APPROVAL;

      await expect(
        useCases.requestCode('d-1', 'c-1', 'ana@correo.mx', null),
      ).rejects.toThrow(BadRequestException);
      expect(verificationCodes.issue).not.toHaveBeenCalled();
    });

    it('no emite código si el invitado ya firmó', async () => {
      signer.status = COLLABORATOR_STATUS_ENUM.SIGNED;

      await expect(
        useCases.requestCode('d-1', 'c-1', 'ana@correo.mx', null),
      ).rejects.toThrow(BadRequestException);
    });

    it('no emite código fuera de turno', async () => {
      signer.signingOrder = 2;
      collaborators.find.mockResolvedValue([
        { ...signer, id: 'c-0', signingOrder: 1 },
        signer,
      ]);

      await expect(
        useCases.requestCode('d-1', 'c-1', 'ana@correo.mx', null),
      ).rejects.toThrow(ForbiddenException);
    });

    it('no emite código si la invitación ya tiene cuenta vinculada', async () => {
      signer.accountId = 'acc-9';

      await expect(
        useCases.requestCode('d-1', 'c-1', 'ana@correo.mx', null),
      ).rejects.toThrow(GuestAdvancedInvitationNotFoundException);
    });

    it('no falla si el correo no sale; lo reporta', async () => {
      email.sendVerificationCodeNotification.mockRejectedValue(
        new Error('smtp'),
      );

      await expect(
        useCases.requestCode('d-1', 'c-1', 'ana@correo.mx', null),
      ).resolves.toEqual({ emailDelivered: false });
    });
  });

  describe('verifyCode', () => {
    it('sin correo en la petición canjea el código y emite el acceso al correo guardado', async () => {
      await useCases.verifyCode('d-1', 'c-1', null, '123456', '10.0.0.2');

      expect(verificationCodes.verifyAndConsume).toHaveBeenCalledWith(
        'd-1',
        'c-1',
        '123456',
        VERIFICATION_EVENT_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
        manager,
      );
      expect(accesses.issue).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          email: 'ana@correo.mx',
          ipAddress: '10.0.0.2',
        }),
      );
    });

    it('consume el código y emite el acceso en la MISMA transacción', async () => {
      const result = await useCases.verifyCode(
        'd-1',
        'c-1',
        'ana@correo.mx',
        '123456',
        '10.0.0.1',
      );

      expect(verificationCodes.verifyAndConsume).toHaveBeenCalledWith(
        'd-1',
        'c-1',
        '123456',
        VERIFICATION_EVENT_ENUM.GUEST_ADVANCED_SIGNATURE_ACCESS,
        manager,
      );
      expect(accesses.issue).toHaveBeenCalledWith(manager, {
        documentId: 'd-1',
        collaboratorId: 'c-1',
        email: 'ana@correo.mx',
        purpose: PURPOSE,
        ipAddress: '10.0.0.1',
        ttlSeconds: GUEST_ADVANCED_ACCESS_TTL_SECONDS,
      });
      expect(tokens.issue).toHaveBeenCalledWith({ id: 'acc-1' });
      expect(result.accessToken).toBe('tok');
    });

    it('un código incorrecto no emite acceso', async () => {
      verificationCodes.verifyAndConsume.mockRejectedValue(
        new BadRequestException('Código de verificación inválido'),
      );

      await expect(
        useCases.verifyCode('d-1', 'c-1', 'ana@correo.mx', '000000', null),
      ).rejects.toThrow('Código de verificación inválido');
      expect(accesses.issue).not.toHaveBeenCalled();
      expect(tokens.issue).not.toHaveBeenCalled();
    });

    it('revalida la invitación al canjear: si ya firmó, no emite acceso', async () => {
      signer.status = COLLABORATOR_STATUS_ENUM.SIGNED;

      await expect(
        useCases.verifyCode('d-1', 'c-1', 'ana@correo.mx', '123456', null),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('dos canjes simultáneos: el que choca con el índice único recibe 409', async () => {
      const uniqueViolation = new QueryFailedError(
        'INSERT',
        [],
        new Error('dup'),
      );
      (uniqueViolation as unknown as { code: string }).code = '23505';
      dataSource.transaction.mockRejectedValue(uniqueViolation);

      await expect(
        useCases.verifyCode('d-1', 'c-1', 'ana@correo.mx', '123456', null),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('getDocument', () => {
    const claims = {
      accessId: 'acc-1',
      documentId: 'd-1',
      collaboratorId: 'c-1',
      purpose: PURPOSE,
    };

    it('publica el hash vigente y si puede firmar', async () => {
      const view = await useCases.getDocument('d-1', claims);

      expect(view).toEqual(
        expect.objectContaining({
          canSign: true,
          documentHash: 'f'.repeat(64),
          fileUrl: 'https://minio/doc.pdf',
        }),
      );
    });

    it('deja de servir en cuanto el colaborador vincula una cuenta', async () => {
      signer.accountId = 'acc-9';

      await expect(useCases.getDocument('d-1', claims)).rejects.toThrow(
        GuestAdvancedInvitationNotFoundException,
      );
    });
  });
});
