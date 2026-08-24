import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { GetCurrentIdentityVerificationUseCase } from './get-current-identity-verification.use-case';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { IDENTITY_CHECK_OUTCOME_ENUM } from '../enums/identity-check-outcome.enum';

const USER_ID = 'user-1';
const HOSTED_URL = 'https://verify.didit.me/session/abc';

describe('GetCurrentIdentityVerificationUseCase', () => {
  let useCase: GetCurrentIdentityVerificationUseCase;
  let identityVerificationRepository: { findOne: jest.Mock };
  let userRepository: { findOne: jest.Mock };

  function givenUser(
    status = SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED,
    overrides: Record<string, unknown> = {},
  ): void {
    userRepository.findOne.mockResolvedValue({
      id: USER_ID,
      signingCredentialStatus: status,
      identityVerifiedAt: null,
      signatureId: null,
      ...overrides,
    });
  }

  function givenAttempt(overrides: Record<string, unknown> = {}): void {
    identityVerificationRepository.findOne.mockResolvedValue({
      id: 'attempt-1',
      provider: IDENTITY_VERIFICATION_PROVIDER_ENUM.DIDIT,
      status: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
      providerMetadata: { hostedUrl: HOSTED_URL },
      decision: null,
      failureReason: null,
      startedAt: null,
      completedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-08-20T09:00:00.000Z'),
      ...overrides,
    });
  }

  beforeEach(async () => {
    identityVerificationRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    userRepository = { findOne: jest.fn() };
    givenUser();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetCurrentIdentityVerificationUseCase,
        {
          provide: getRepositoryToken(IdentityVerificationEntity),
          useValue: identityVerificationRepository,
        },
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
      ],
    }).compile();

    useCase = module.get(GetCurrentIdentityVerificationUseCase);
  });

  it('sin intentos devuelve el estado inicial y verification en null', async () => {
    const result = await useCase.execute(USER_ID);

    expect(result.verification).toBeNull();
    expect(result.signingCredentialStatus).toBe(
      SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_REQUIRED,
    );
    expect(result.signingCredentialConfigured).toBe(false);
  });

  it('deriva signingCredentialConfigured del estado global, sin columna aparte', async () => {
    givenUser(SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED, {
      signatureId: 'sig-1',
    });

    const result = await useCase.execute(USER_ID);

    expect(result.signingCredentialConfigured).toBe(true);
    expect(result.signatureRegistered).toBe(true);
  });

  describe('resumen del veredicto', () => {
    it('expone qué comprobó el proveedor y cómo salió cada cosa', async () => {
      givenAttempt({
        decision: {
          id_verification: { status: 'Approved' },
          face_match: { status: 'match' },
          liveness: { status: 'live' },
        },
      });

      const result = await useCase.execute(USER_ID);

      expect(result.verification?.checks).toEqual({
        documentReading: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
        faceMatch: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
        liveness: IDENTITY_CHECK_OUTCOME_ENUM.PASSED,
      });
    });

    it('también lo expone en un intento rechazado: explica cuál comprobación falló', async () => {
      givenAttempt({
        status: IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED,
        failureReason: 'El rostro no coincide con la identificación',
        decision: {
          id_verification: { status: 'Approved' },
          face_match: { status: 'no_match' },
        },
      });

      const result = await useCase.execute(USER_ID);

      expect(result.verification?.checks?.faceMatch).toBe(
        IDENTITY_CHECK_OUTCOME_ENUM.FAILED,
      );
    });

    it('es null mientras el intento no tiene veredicto', async () => {
      givenAttempt({
        status: IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
        decision: null,
      });

      const result = await useCase.execute(USER_ID);

      expect(result.verification?.checks).toBeNull();
    });

    it('nunca deja salir el veredicto crudo del proveedor', async () => {
      givenAttempt({
        decision: {
          id_verification: {
            status: 'Approved',
            first_name: 'Juan',
            document_number: 'PELJ850101HDFRNN08',
            portrait_image: 'https://cdn.didit.me/portrait.jpg',
          },
          face_match: { status: 'match', score: 97.4 },
        },
      });

      const serializado = JSON.stringify(await useCase.execute(USER_ID));

      expect(serializado).not.toContain('Juan');
      expect(serializado).not.toContain('PELJ850101HDFRNN08');
      expect(serializado).not.toContain('cdn.didit.me');
      expect(serializado).not.toContain('97.4');
    });
  });

  describe('la URL hospedada sólo se expone si sirve', () => {
    it('la devuelve mientras la sesión sigue abierta y vigente', async () => {
      givenAttempt({
        status: IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const result = await useCase.execute(USER_ID);

      expect(result.verification?.url).toBe(HOSTED_URL);
    });

    it('no la devuelve si la sesión ya expiró', async () => {
      givenAttempt({
        status: IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
        expiresAt: new Date(Date.now() - 1_000),
      });

      const result = await useCase.execute(USER_ID);

      expect(result.verification?.url).toBeNull();
    });

    it('no la devuelve en un intento ya rechazado', async () => {
      givenAttempt({ status: IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED });

      const result = await useCase.execute(USER_ID);

      expect(result.verification?.url).toBeNull();
    });
  });

  it('lanza 404 si el usuario no existe', async () => {
    userRepository.findOne.mockResolvedValue(null);

    await expect(useCase.execute(USER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
