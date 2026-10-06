import { DiditConfigurationException } from 'src/identity-verification/exceptions/identity-verification.exceptions';
import { BiometricReferencePortraitUnavailableException } from '../biometric-signature.exceptions';
import {
  BiometricSignatureDiditService,
  DIDIT_PORTRAIT_MAX_BYTES,
  pickReferencePortraitUrl,
  toBiometricVendorData,
} from './biometric-signature-didit.service';

describe('BiometricSignatureDiditService', () => {
  let api: { createBiometricSession: jest.Mock; getSessionDecision: jest.Mock };
  let downloader: { download: jest.Mock };
  let config: Record<string, string | undefined>;
  let service: BiometricSignatureDiditService;

  beforeEach(() => {
    api = {
      createBiometricSession: jest.fn().mockResolvedValue({ sessionId: 's-1' }),
      getSessionDecision: jest.fn().mockResolvedValue({
        liveness_checks: [
          {
            status: 'Approved',
            reference_image: 'https://didit.me/selfie.jpg',
          },
        ],
      }),
    };
    downloader = {
      download: jest.fn().mockResolvedValue({ content: Buffer.from('jpeg') }),
    };
    config = {
      DIDIT_BIOMETRIC_AUTH_WORKFLOW_ID: 'wf-auth',
      DIDIT_BIOMETRIC_GUEST_KYC_WORKFLOW_ID: 'wf-kyc',
    };
    service = new BiometricSignatureDiditService(
      api as never,
      downloader as never,
      { get: (key: string) => config[key] } as never,
    );
  });

  it('usa un workflow distinto para cada tipo de firmante', () => {
    expect(service.workflowFor('ACCOUNT')).toBe('wf-auth');
    expect(service.workflowFor('GUEST')).toBe('wf-kyc');
  });

  it('sin el workflow configurado no abre nada', () => {
    config.DIDIT_BIOMETRIC_GUEST_KYC_WORKFLOW_ID = undefined;

    expect(() => service.workflowFor('GUEST')).toThrow(
      DiditConfigurationException,
    );
  });

  it('firmante con cuenta: manda el retrato de su identidad aprobada en base64', async () => {
    await service.openAccountSession({
      attemptId: 'a-1',
      workflowId: 'wf-auth',
      callbackUrl: 'https://app/d',
      identitySessionId: 'identity-session',
    });

    expect(api.getSessionDecision).toHaveBeenCalledWith('identity-session');
    expect(downloader.download).toHaveBeenCalledWith(
      'https://didit.me/selfie.jpg',
      'retrato',
    );
    expect(api.createBiometricSession).toHaveBeenCalledWith({
      workflowId: 'wf-auth',
      vendorData: 'biometric-signature-attempt:a-1',
      callbackUrl: 'https://app/d',
      portraitImageBase64: Buffer.from('jpeg').toString('base64'),
    });
  });

  it('invitado: KYC sin retrato de referencia', async () => {
    await service.openGuestSession({
      attemptId: 'a-2',
      workflowId: 'wf-kyc',
      callbackUrl: 'https://app/p',
    });

    expect(api.getSessionDecision).not.toHaveBeenCalled();
    expect(api.createBiometricSession).toHaveBeenCalledWith({
      workflowId: 'wf-kyc',
      vendorData: 'biometric-signature-attempt:a-2',
      callbackUrl: 'https://app/p',
    });
  });

  it.each([
    [
      'la identidad no trae imagen del rostro',
      () => api.getSessionDecision.mockResolvedValue({}),
    ],
    [
      'la imagen no se pudo descargar',
      () =>
        downloader.download.mockRejectedValue(new Error('host no permitido')),
    ],
    [
      'la imagen supera los 2 MB que admite Didit',
      () =>
        downloader.download.mockResolvedValue({
          content: Buffer.alloc(DIDIT_PORTRAIT_MAX_BYTES + 1),
        }),
    ],
  ])('sin retrato utilizable no abre la sesión (%s)', async (_, arrange) => {
    arrange();

    await expect(
      service.openAccountSession({
        attemptId: 'a-1',
        workflowId: 'wf-auth',
        callbackUrl: 'https://app/d',
        identitySessionId: 'identity-session',
      }),
    ).rejects.toBeInstanceOf(BiometricReferencePortraitUnavailableException);
    expect(api.createBiometricSession).not.toHaveBeenCalled();
  });
});

describe('pickReferencePortraitUrl', () => {
  it('prefiere la cara de una prueba de vida aprobada sobre el retrato de la identificación', () => {
    expect(
      pickReferencePortraitUrl({
        id_verifications: [
          { status: 'Approved', portrait_image: 'https://id' },
        ],
        liveness_checks: [
          { status: 'Approved', reference_image: 'https://live' },
        ],
      }),
    ).toBe('https://live');
  });

  it('ignora pruebas no aprobadas y cae al retrato de la identificación', () => {
    expect(
      pickReferencePortraitUrl({
        liveness_checks: [
          { status: 'Declined', reference_image: 'https://live' },
        ],
        id_verification: { status: 'Approved', portrait_image: 'https://id' },
      }),
    ).toBe('https://id');
  });

  it('devuelve null si nada aprobado trae imagen', () => {
    expect(pickReferencePortraitUrl({ face_matches: [] })).toBeNull();
  });
});

describe('toBiometricVendorData', () => {
  it('sólo lleva el id del intento', () => {
    expect(toBiometricVendorData('a-1')).toBe(
      'biometric-signature-attempt:a-1',
    );
  });
});
