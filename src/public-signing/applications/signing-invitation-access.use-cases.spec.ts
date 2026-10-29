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
import { PublicSigningInvitationResolver } from '../services/public-signing-invitation-resolver.service';
import {
  RENEW_INVITATION_MESSAGE,
  SigningInvitationAccessUseCases,
} from './signing-invitation-access.use-cases';

const TOKEN = 'q'.repeat(43);
const LAUNCH = `sla_${'l'.repeat(43)}`;
const METADATA = { ipAddress: '10.0.0.5', userAgent: 'Mozilla/5.0' };

describe('SigningInvitationAccessUseCases', () => {
  let resolved: Record<string, any>;
  let resolver: {
    resolve: jest.Mock;
    resolveById: jest.Mock;
    assertActive: jest.Mock;
  };
  let codes: { issue: jest.Mock; verifyAndConsume: jest.Mock };
  let accesses: { issue: jest.Mock };
  let sessionTokens: { issue: jest.Mock };
  let accessTokens: { issue: jest.Mock };
  let launches: { redeem: jest.Mock };
  let limits: Record<string, jest.Mock>;
  let delivery: { deliver: jest.Mock };
  let email: { sendVerificationCodeNotification: jest.Mock };
  let audit: { create: jest.Mock };
  let useCases: SigningInvitationAccessUseCases;

  beforeEach(() => {
    resolved = {
      invitation: {
        id: 'inv-1',
        expiresAt: new Date('2026-11-03T00:00:00.000Z'),
      },
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
        email: 'ana@correo.com',
      },
      status: SIGNING_INVITATION_STATUS_ENUM.ACTIVE,
    };
    // El `assertActive` real: 404 genérico si no está activa o no admite la firma pública.
    const realResolver = new PublicSigningInvitationResolver(
      {} as never,
      {} as never,
    );
    resolver = {
      resolve: jest.fn(async () => resolved),
      resolveById: jest.fn(async () => resolved),
      assertActive: jest.fn((value) => realResolver.assertActive(value)),
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
    accessTokens = {
      issue: jest.fn(() => ({ token: 'jwt-de-acceso', expiresAt: new Date() })),
    };
    launches = { redeem: jest.fn(async () => ({ invitationId: 'inv-1' })) };
    limits = {
      consume: jest.fn().mockResolvedValue(undefined),
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      record: jest.fn().mockResolvedValue(1),
      reset: jest.fn().mockResolvedValue(undefined),
    };
    delivery = { deliver: jest.fn().mockResolvedValue({}) };
    email = { sendVerificationCodeNotification: jest.fn() };
    audit = { create: jest.fn() };

    useCases = new SigningInvitationAccessUseCases(
      {
        transaction: jest.fn(async (work: (m: unknown) => unknown) =>
          work('manager'),
        ),
      } as never,
      resolver as never,
      codes as never,
      accesses as never,
      sessionTokens as never,
      accessTokens as never,
      launches as never,
      limits as never,
      delivery as never,
      email as never,
      audit as never,
    );
  });

  describe('canje del token inicial', () => {
    it('correo: devuelve el contexto con el correo enmascarado y un acceso del canal EMAIL', async () => {
      const opened = await useCases.openWithInvitationToken(TOKEN);

      expect(opened.context).toEqual(
        expect.objectContaining({
          status: SIGNING_INVITATION_STATUS_ENUM.ACTIVE,
          signer: expect.objectContaining({ maskedEmail: 'a***@correo.com' }),
        }),
      );
      expect(accessTokens.issue).toHaveBeenCalledWith({
        invitationId: 'inv-1',
        channel: 'EMAIL',
      });
      expect(opened.access?.token).toBe('jwt-de-acceso');
    });

    it('portal: consume el token de lanzamiento y abre la MISMA invitación con el canal THIRD_PARTY_PORTAL', async () => {
      await useCases.openWithLaunchToken(LAUNCH);

      expect(launches.redeem).toHaveBeenCalledWith(LAUNCH);
      expect(resolver.resolveById).toHaveBeenCalledWith('inv-1');
      expect(accessTokens.issue).toHaveBeenCalledWith({
        invitationId: 'inv-1',
        channel: 'THIRD_PARTY_PORTAL',
      });
    });

    it('portal: un token vencido, inexistente o ya usado da el 404 genérico', async () => {
      launches.redeem.mockResolvedValue(null);
      await expect(useCases.openWithLaunchToken(LAUNCH)).rejects.toThrow(
        new NotFoundException('Esta invitación no es válida.'),
      );
      expect(accessTokens.issue).not.toHaveBeenCalled();
    });

    it.each([
      SIGNING_INVITATION_STATUS_ENUM.WAITING_FOR_PREVIOUS_SIGNER,
      SIGNING_INVITATION_STATUS_ENUM.EXPIRED,
      SIGNING_INVITATION_STATUS_ENUM.ALREADY_SIGNED,
    ])(
      '%s: sólo el estado y sin acceso para pedir el código',
      async (status) => {
        resolved.status = status;
        await expect(useCases.openWithInvitationToken(TOKEN)).resolves.toEqual({
          context: { status },
          access: null,
        });
      },
    );
  });

  describe('requestCode', () => {
    it('envía el código al correo GUARDADO de la invitación y lo audita con el canal, sin el código', async () => {
      await expect(
        useCases.requestCode(resolved as never, 'THIRD_PARTY_PORTAL', METADATA),
      ).resolves.toEqual({
        maskedEmail: 'a***@correo.com',
        emailDelivered: true,
        resendAfterSeconds: 60,
      });
      expect(codes.issue).toHaveBeenCalledWith(
        'd-1',
        'c-1',
        VERIFICATION_EVENT_ENUM.PUBLIC_SIGNING_ACCESS,
        '10.0.0.5',
      );
      expect(email.sendVerificationCodeNotification).toHaveBeenCalledWith(
        'ana@correo.com',
        'contrato.pdf',
        '123456',
      );
      const payload = audit.create.mock.calls[0][0];
      expect(payload).toEqual(
        expect.objectContaining({
          operation: AuditAction.SIGNING_INVITATION_OTP_SENT,
          actor: expect.objectContaining({
            authMechanism: 'LAUNCH_TOKEN',
            accessChannel: 'THIRD_PARTY_PORTAL',
            invitationId: 'inv-1',
          }),
        }),
      );
      expect(JSON.stringify(payload)).not.toContain('123456');
    });

    it('Juan antes de su turno no puede pedir el código', async () => {
      resolved.status =
        SIGNING_INVITATION_STATUS_ENUM.WAITING_FOR_PREVIOUS_SIGNER;
      await expect(
        useCases.requestCode(resolved as never, 'EMAIL', METADATA),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(codes.issue).not.toHaveBeenCalled();
    });

    it('429 si se pidieron demasiados códigos', async () => {
      limits.consume.mockRejectedValue(new SigningRateLimitException());
      await expect(
        useCases.requestCode(resolved as never, 'EMAIL', METADATA),
      ).rejects.toBeInstanceOf(SigningRateLimitException);
      expect(codes.issue).not.toHaveBeenCalled();
    });
  });

  describe('verifyCode', () => {
    it('consume el código y abre la sesión pública con el canal de entrada', async () => {
      await expect(
        useCases.verifyCode(
          resolved as never,
          'THIRD_PARTY_PORTAL',
          '123456',
          METADATA,
        ),
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
          ttlSeconds: 1800,
        }),
      );
      expect(sessionTokens.issue).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'session-1' }),
        'inv-1',
        'THIRD_PARTY_PORTAL',
      );
      expect(limits.reset).toHaveBeenCalledWith(
        'inv:inv-1',
        OTP_VERIFY_FAILURES,
      );
    });

    it('quien no controla el correo no abre sesión: el fallo se cuenta y se audita', async () => {
      codes.verifyAndConsume.mockRejectedValue(
        new BadRequestException('Código de verificación inválido'),
      );

      await expect(
        useCases.verifyCode(resolved as never, 'EMAIL', '000000', METADATA),
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
        useCases.verifyCode(resolved as never, 'EMAIL', '123456', METADATA),
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
          auditActor: expect.objectContaining({
            authMechanism: 'INVITATION_TOKEN',
            accessChannel: 'EMAIL',
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
  });
});
