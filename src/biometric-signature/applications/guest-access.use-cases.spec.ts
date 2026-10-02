import { DOCUMENT_STATUS_ENUM } from 'src/document/enum/document-status.enum';
import { COLLABORATOR_STATUS_ENUM } from 'src/document/enum/collaborator-status.enum';
import { VERIFICATION_EVENT_ENUM } from 'src/document/enum/verification-event.enum';
import { GuestInvitationNotFoundException } from '../biometric-signature.exceptions';
import { GuestBiometricAccessUseCases } from './guest-access.use-cases';

describe('GuestBiometricAccessUseCases', () => {
  let document: Record<string, unknown>;
  let signer: Record<string, unknown>;
  let signers: { resolveGuestSigner: jest.Mock };
  let codes: { issue: jest.Mock; verifyAndConsume: jest.Mock };
  let email: { sendVerificationCodeNotification: jest.Mock };
  let tokens: { issue: jest.Mock };
  let useCases: GuestBiometricAccessUseCases;

  beforeEach(() => {
    document = {
      id: 'd-1',
      fileName: 'contrato.pdf',
      status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      isSequential: false,
    };
    signer = {
      id: 'c-1',
      status: COLLABORATOR_STATUS_ENUM.PENDING,
      email: 'ana@correo.mx',
      account: null,
    };
    signers = {
      resolveGuestSigner: jest.fn(async () => ({
        document,
        signer,
        signers: [signer],
      })),
    };
    codes = {
      issue: jest.fn().mockResolvedValue({ code: '123456' }),
      verifyAndConsume: jest.fn().mockResolvedValue(undefined),
    };
    email = { sendVerificationCodeNotification: jest.fn() };
    tokens = {
      issue: jest
        .fn()
        .mockReturnValue({ accessToken: 't', expiresAt: new Date() }),
    };
    useCases = new GuestBiometricAccessUseCases(
      signers as never,
      codes as never,
      email as never,
      {
        getDocumentMinioURL: jest
          .fn()
          .mockResolvedValue({
            secureUrl: 'https://minio/doc.pdf',
            expiresIn: 86400,
          }),
      } as never,
      tokens as never,
    );
  });

  it('checkInvitation responde false sin decir por qué', async () => {
    signers.resolveGuestSigner.mockRejectedValue(
      new GuestInvitationNotFoundException(),
    );

    await expect(
      useCases.checkInvitation('d-1', 'c-1', 'ana@correo.mx'),
    ).resolves.toEqual({ guestBiometric: false });
  });

  it('envía el código al correo GUARDADO de la invitación, con su propio evento', async () => {
    signer.email = 'guardado@correo.mx';

    await expect(
      useCases.requestCode('d-1', 'c-1', 'GUARDADO@correo.mx', '10.0.0.1'),
    ).resolves.toEqual({ emailDelivered: true });

    expect(codes.issue).toHaveBeenCalledWith(
      'd-1',
      'c-1',
      VERIFICATION_EVENT_ENUM.GUEST_BIOMETRIC_ACCESS,
      '10.0.0.1',
    );
    expect(email.sendVerificationCodeNotification).toHaveBeenCalledWith(
      'guardado@correo.mx',
      'contrato.pdf',
      '123456',
    );
  });

  it('si el correo no sale, lo dice sin fallar', async () => {
    email.sendVerificationCodeNotification.mockRejectedValue(new Error('SMTP'));

    await expect(
      useCases.requestCode('d-1', 'c-1', 'ana@correo.mx', '10.0.0.1'),
    ).resolves.toEqual({ emailDelivered: false });
  });

  it('canjea el código (sólo del evento de acceso) por un token de la invitación', async () => {
    await useCases.verifyCode('d-1', 'c-1', 'ana@correo.mx', '123456');

    expect(codes.verifyAndConsume).toHaveBeenCalledWith(
      'd-1',
      'c-1',
      '123456',
      VERIFICATION_EVENT_ENUM.GUEST_BIOMETRIC_ACCESS,
    );
    expect(tokens.issue).toHaveBeenCalledWith({
      documentId: 'd-1',
      collaboratorId: 'c-1',
      email: 'ana@correo.mx',
    });
  });

  it('sin código válido no emite token', async () => {
    codes.verifyAndConsume.mockRejectedValue(new Error('Código inválido'));

    await expect(
      useCases.verifyCode('d-1', 'c-1', 'ana@correo.mx', '000000'),
    ).rejects.toThrow('Código inválido');
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('muestra el documento y si puede firmar', async () => {
    await expect(
      useCases.getDocument('d-1', {
        documentId: 'd-1',
        collaboratorId: 'c-1',
        email: 'ana@correo.mx',
      }),
    ).resolves.toEqual({
      documentId: 'd-1',
      fileName: 'contrato.pdf',
      documentStatus: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE,
      signerStatus: COLLABORATOR_STATUS_ENUM.PENDING,
      canSign: true,
      fileUrl: 'https://minio/doc.pdf',
      expiresIn: 86400,
    });
  });

  it('no muestra un documento que todavía no se envió a firma', async () => {
    document.status = DOCUMENT_STATUS_ENUM.PENDING_APPROVAL;

    await expect(
      useCases.getDocument('d-1', {
        documentId: 'd-1',
        collaboratorId: 'c-1',
        email: 'ana@correo.mx',
      }),
    ).rejects.toBeInstanceOf(GuestInvitationNotFoundException);
  });
});
