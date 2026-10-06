import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { COLABORATOR_TYPE_ENUM } from 'src/document/enum/colaborator-type.enum';
import { GuestInvitationNotFoundException } from '../biometric-signature.exceptions';
import { BiometricSignerService } from './biometric-signer.service';

function guest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-1',
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    status: COLLABORATOR_STATUS_ENUM.PENDING,
    signatureType: SIGNATURE_TYPE_ENUM.BIOMETRIC,
    signingOrder: 1,
    accountId: null,
    account: null,
    email: 'Ana@Correo.mx',
    ...overrides,
  };
}

describe('BiometricSignerService', () => {
  let signers: Record<string, unknown>[];
  let document: Record<string, unknown>;
  let hasConsumedCode: jest.Mock;
  let service: BiometricSignerService;

  beforeEach(() => {
    signers = [guest()];
    document = {
      id: 'd-1',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      originalHash: 'hash',
      isSequential: true,
      requiresVerification: false,
    };
    hasConsumedCode = jest.fn().mockResolvedValue(true);
    service = new BiometricSignerService(
      { find: jest.fn(async () => signers) } as never,
      { findOne: jest.fn(async () => document) } as never,
      { hasConsumedCode } as never,
      { assertCanSign: jest.fn() } as never,
    );
  });

  describe('resolveGuestSigner', () => {
    it('acepta al firmante biométrico sin cuenta con el mismo correo (sin distinguir mayúsculas)', async () => {
      const resolved = await service.resolveGuestSigner(
        'd-1',
        'c-1',
        ' ana@correo.MX ',
      );

      expect(resolved.signer.id).toBe('c-1');
    });

    it.each([
      ['otro colaborador', () => undefined, 'c-otro', 'ana@correo.mx'],
      ['otro correo', () => undefined, 'c-1', 'otra@correo.mx'],
      [
        'el colaborador ya tiene cuenta',
        () => Object.assign(signers[0], { accountId: 'acc-1' }),
        'c-1',
        'ana@correo.mx',
      ],
      [
        'su firma no es biométrica',
        () =>
          Object.assign(signers[0], {
            signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
          }),
        'c-1',
        'ana@correo.mx',
      ],
    ])(
      'rechaza con el mismo mensaje si %s',
      async (_, arrange, collaboratorId, email) => {
        arrange();

        await expect(
          service.resolveGuestSigner('d-1', collaboratorId, email),
        ).rejects.toBeInstanceOf(GuestInvitationNotFoundException);
      },
    );
  });

  describe('assertCanStart', () => {
    async function resolved() {
      return service.resolveGuestSigner('d-1', 'c-1', 'ana@correo.mx');
    }

    it('deja iniciar a un firmante pendiente y en turno', async () => {
      await expect(
        service.assertCanStart(await resolved(), { requireSignCode: false }),
      ).resolves.toBeUndefined();
    });

    it.each([
      [
        'el documento no está pendiente de firma',
        () => (document.status = DOCUMENT_STATUS_ENUM.SIGNED),
        BadRequestException,
      ],
      [
        'no hay hash del documento',
        () => (document.originalHash = null),
        BadRequestException,
      ],
      [
        'ya respondió',
        () => (signers[0].status = COLLABORATOR_STATUS_ENUM.SIGNED),
        BadRequestException,
      ],
      [
        'no es su turno',
        () => signers.unshift(guest({ id: 'c-0', signingOrder: 0 })),
        ForbiddenException,
      ],
    ])('rechaza si %s', async (_, arrange, expected) => {
      arrange();

      await expect(
        service.assertCanStart(await resolved(), { requireSignCode: false }),
      ).rejects.toBeInstanceOf(expected);
    });

    it('exige el código de firma sólo cuando se pide (firmante con cuenta)', async () => {
      document.requiresVerification = true;
      hasConsumedCode.mockResolvedValue(false);

      await expect(
        service.assertCanStart(await resolved(), { requireSignCode: false }),
      ).resolves.toBeUndefined();
      await expect(
        service.assertCanStart(await resolved(), { requireSignCode: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
