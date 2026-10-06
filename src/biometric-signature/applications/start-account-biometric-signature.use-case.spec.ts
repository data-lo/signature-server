import { AuthorizationContext } from 'src/authorization/interfaces/authorization-context.interface';
import { BiometricIdentityNotVerifiedException } from '../biometric-signature.exceptions';
import { StartAccountBiometricSignatureUseCase } from './start-account-biometric-signature.use-case';

const DTO = {
  geolocation: { latitude: 19.4, longitude: -99.1 },
  biometricConsent: true,
};
const AUTH = { userId: 'u-1' } as unknown as AuthorizationContext;

describe('StartAccountBiometricSignatureUseCase', () => {
  let identityRepository: { findOne: jest.Mock };
  let signers: { resolveAccountSigner: jest.Mock; assertCanStart: jest.Mock };
  let launcher: { launch: jest.Mock };
  let useCase: StartAccountBiometricSignatureUseCase;
  const resolved = {
    document: { id: 'd-1' },
    signer: { id: 'c-1' },
    signers: [],
  };

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.ejemplo.com';
    identityRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({
          id: 'iv-1',
          providerSessionId: 'identity-session',
        }),
    };
    signers = {
      resolveAccountSigner: jest.fn().mockResolvedValue(resolved),
      assertCanStart: jest.fn().mockResolvedValue(undefined),
    };
    launcher = { launch: jest.fn().mockResolvedValue({ attemptId: 'a-1' }) };
    useCase = new StartAccountBiometricSignatureUseCase(
      identityRepository as never,
      signers as never,
      launcher as never,
    );
  });

  it('valida al firmante (con código de firma) y abre la sesión contra su identidad aprobada', async () => {
    await useCase.execute('d-1', 'u-1', DTO, AUTH, '10.0.0.1');

    expect(signers.resolveAccountSigner).toHaveBeenCalledWith(
      'd-1',
      'u-1',
      AUTH,
    );
    expect(signers.assertCanStart).toHaveBeenCalledWith(resolved, {
      requireSignCode: true,
    });
    expect(launcher.launch).toHaveBeenCalledWith({
      resolved,
      kind: 'ACCOUNT',
      userId: 'u-1',
      identity: { id: 'iv-1', providerSessionId: 'identity-session' },
      geolocation: DTO.geolocation,
      ipAddress: '10.0.0.1',
      callbackUrl: 'https://app.ejemplo.com/dashboard/documents/d-1',
    });
  });

  it('sin identidad Didit aprobada no abre ninguna sesión', async () => {
    identityRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute('d-1', 'u-1', DTO, AUTH, null),
    ).rejects.toBeInstanceOf(BiometricIdentityNotVerifiedException);
    expect(launcher.launch).not.toHaveBeenCalled();
  });
});
