import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AuditAction } from 'src/audit/schema/audit-document';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { GUEST_SIGNING_ACCESS_PURPOSE_ENUM } from 'src/document/enum/guest-signing-access-purpose.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { VERIFICATION_EVENT_ENUM } from 'src/document/enum/verification-event.enum';
import {
  OTP_VERIFY_FAILURES,
  SigningRateLimitException,
} from 'src/signing-invitation/signing-rate-limit.service';

import { SIGNING_INVITATION_STATUS_ENUM } from '../enums/signing-invitation-status.enum';
import {
  RENEW_INVITATION_MESSAGE,
  SigningInvitationAccessUseCases,
} from './signing-invitation-access.use-cases';

const TOKEN = 'q'.repeat(43);
const METADATA = { ipAddress: '10.0.0.5', userAgent: 'Mozilla/5.0' };

describe('SigningInvitationAccessUseCases', () => {
  let resolved: Record<string, any>;
  let resolver: { resolve: jest.Mock; resolveActive: jest.Mock };
  let codes: { issue: jest.Mock; verifyAndConsume: jest.Mock };
  let accesses: { issue: jest.Mock };
  let sessionTokens: { issue: jest.Mock };
  let limits: Record<string, jest.Mock>;
  let delivery: { deliver: jest.Mock };
  let email: { sendVerificationCodeNotification: jest.Mock };
  let audit: { create: jest.Mock };
  let useCases: SigningInvitationAccessUseCases;

  beforeEach(() => {
    resolved = {
      invitation: { id: 'inv-1' },
      document: {
        id: 'd-1',
        fileName: 'contrato.pdf',
        status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      },
      collaborator: {
        id: 'c-1',
        colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        status: COLLABORATOR_STATUS_ENUM.PENDING,
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        accountId: null,
        account: null,
        email: 'ana@acme.mx',
      },
      status: SIGNING_INVITATION_STATUS_ENUM.ACTIVE,
    };
    resolver = {
      resolve: jest.fn(async () => resolved),
      resolveActive: jest.fn(async () => resolved),
    };
    codes = {
      issue: jest.fn(async () => ({ code: '123456' })),
      verifyAndConsume: jest.fn().mockResolvedValue(undefined),
    };
    accesses = {
      issue: jest.fn(async () => ({
        id: 'session-1',
        documentId: 'd-1',
        collaboratorId: 'c-1',
        expiresAt: new Date(Date.now() + 1_800_000),
      })),
    };
    sessionTokens = {
      issue: jest.fn(() => ({ token: 'jwt-de-sesion', expiresAt: new Date() })),
    };
    limits = {
      consume: jest.fn().mockResolvedValue(undefined),
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      record: jest.fn().mockResolvedValue(1),
      reset: jest.fn().mockResolvedValue(undefined),
    };
    delivery = { deliver: jest.fn().mockResolvedValue({}) };
    email = { sendVerificationCodeNotification: jest.fn() };
    audit = { create: jest.fn() };

    const dataSource = {
      transaction: jest.fn(async (work: (m: unknown) => unknown) =>
        work('manager'),
      ),
    };
    useCases = new SigningInvitationAccessUseCases(
      dataSource as never,
      resolver as never,
      codes as never,
      accesses as never,
      sessionTokens as never,
      limits as never,
      delivery as never,
      email as never,
      audit as never,
    );
  });

  describe('requestCode', () => {
    it('envía el código al correo GUARDADO del firmante y lo audita sin el código', async () => {
      await expect(useCases.requestCode(TOKEN, METADATA)).resolves.toEqual({
        maskedEmail: 'a***@acme.mx',
        emailDelivered: true,
        resendAfterSeconds: 60,
      });
      expect(limits.consume).toHaveBeenCalledWith(
        'inv:inv-1',
        expect.any(Array),
      );
      expect(codes.issue).toHaveBeenCalledWith(
        'd-1',
        'c-1',
        VERIFICATION_EVENT_ENUM.PUBLIC_SIGNING_ACCESS,
        '10.0.0.5',
      );
      expect(email.sendVerificationCodeNotification).toHaveBeenCalledWith(
        'ana@acme.mx',
        'contrato.pdf',
        '123456',
      );
      const auditPayload = audit.create.mock.calls[0][0];
      expect(auditPayload).toEqual(
        expect.objectContaining({
          operation: AuditAction.SIGNING_INVITATION_OTP_SENT,
          actor: expect.objectContaining({
            authMechanism: 'INVITATION_TOKEN',
            invitationId: 'inv-1',
          }),
          result: 'SUCCESS',
        }),
      );
      expect(JSON.stringify(auditPayload)).not.toMatch(/123456|qqqq/);
    });

    it('429 si se pidieron demasiados códigos; no emite otro', async () => {
      limits.consume.mockRejectedValue(new SigningRateLimitException());
      await expect(
        useCases.requestCode(TOKEN, METADATA),
      ).rejects.toBeInstanceOf(SigningRateLimitException);
      expect(codes.issue).not.toHaveBeenCalled();
    });

    it('un token que no está activo da el 404 genérico', async () => {
      resolver.resolveActive.mockRejectedValue(new NotFoundException());
      await expect(
        useCases.requestCode(TOKEN, METADATA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('verifyCode', () => {
    it('consume el código y emite el acceso de sesión pública en la misma transacción', async () => {
      await expect(
        useCases.verifyCode(TOKEN, '123456', METADATA),
      ).resolves.toEqual(expect.objectContaining({ token: 'jwt-de-sesion' }));

      expect(codes.verifyAndConsume).toHaveBeenCalledWith(
        'd-1',
        'c-1',
        '123456',
        VERIFICATION_EVENT_ENUM.PUBLIC_SIGNING_ACCESS,
        'manager',
      );
      expect(accesses.issue).toHaveBeenCalledWith(
        'manager',
        expect.objectContaining({
          purpose: GUEST_SIGNING_ACCESS_PURPOSE_ENUM.PUBLIC_SIGNING_SESSION,
          email: 'ana@acme.mx',
          ttlSeconds: 1800,
        }),
      );
      expect(sessionTokens.issue).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'session-1' }),
        'inv-1',
      );
      expect(limits.reset).toHaveBeenCalledWith(
        'inv:inv-1',
        OTP_VERIFY_FAILURES,
      );
    });

    it('un código equivocado cuenta el fallo, lo audita y no abre sesión', async () => {
      codes.verifyAndConsume.mockRejectedValue(
        new BadRequestException('Código de verificación inválido'),
      );

      await expect(
        useCases.verifyCode(TOKEN, '000000', METADATA),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(limits.record).toHaveBeenCalledWith(
        'inv:inv-1',
        OTP_VERIFY_FAILURES,
      );
      expect(sessionTokens.issue).not.toHaveBeenCalled();
      expect(audit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: AuditAction.SIGNING_INVITATION_OTP_VERIFIED,
          result: 'FAILURE',
        }),
      );
    });

    it('con los intentos agotados ni siquiera valida el código', async () => {
      limits.assertAvailable.mockRejectedValue(new SigningRateLimitException());
      await expect(
        useCases.verifyCode(TOKEN, '123456', METADATA),
      ).rejects.toBeInstanceOf(SigningRateLimitException);
      expect(codes.verifyAndConsume).not.toHaveBeenCalled();
    });
  });

  describe('renew', () => {
    beforeEach(() => {
      resolved.status = SIGNING_INVITATION_STATUS_ENUM.EXPIRED;
    });

    it('un enlace vencido de un documento firmable emite y envía una invitación nueva', async () => {
      await expect(useCases.renew(TOKEN, METADATA)).resolves.toEqual({
        message: RENEW_INVITATION_MESSAGE,
      });
      expect(delivery.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          document: resolved.document,
          collaborator: resolved.collaborator,
          auditActor: expect.objectContaining({
            authMechanism: 'INVITATION_TOKEN',
          }),
        }),
      );
    });

    it.each([
      [
        'el token no existe',
        () => resolver.resolve.mockRejectedValue(new NotFoundException()),
      ],
      [
        'la invitación sigue activa',
        () => (resolved.status = SIGNING_INVITATION_STATUS_ENUM.ACTIVE),
      ],
      [
        'se revocó (hay una más reciente)',
        () => (resolved.status = SIGNING_INVITATION_STATUS_ENUM.REVOKED),
      ],
      [
        'el documento ya no espera firmas',
        () => (resolved.document.status = DOCUMENT_STATUS_ENUM.CANCELLED),
      ],
      [
        'el firmante ya firmó',
        () => (resolved.collaborator.status = COLLABORATOR_STATUS_ENUM.SIGNED),
      ],
    ])('misma respuesta y sin enviar nada si %s', async (_case, mutate) => {
      mutate();
      await expect(useCases.renew(TOKEN, METADATA)).resolves.toEqual({
        message: RENEW_INVITATION_MESSAGE,
      });
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('el límite de reenvíos también responde lo mismo (no confirma que el enlace existe)', async () => {
      delivery.deliver.mockRejectedValue(new SigningRateLimitException());
      await expect(useCases.renew(TOKEN, METADATA)).resolves.toEqual({
        message: RENEW_INVITATION_MESSAGE,
      });
    });
  });
});
