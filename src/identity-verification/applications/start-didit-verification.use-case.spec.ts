import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { StartDiditVerificationUseCase } from './start-didit-verification.use-case';
import { DiditApiService } from '../didit/didit-api.service';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_PROVIDER_ENUM } from '../enums/identity-verification-provider.enum';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { DiditUnavailableException } from '../exceptions/identity-verification.exceptions';

const USER_ID = 'user-1';
const HOSTED_URL = 'https://verify.didit.me/session/abc';

const DIDIT_SESSION = {
  sessionId: 'ses_1',
  url: HOSTED_URL,
  workflowId: 'wf_1',
  expiresAt: new Date('2026-09-01T00:00:00.000Z'),
  raw: { session_id: 'ses_1', url: HOSTED_URL },
};

describe('StartDiditVerificationUseCase', () => {
  let useCase: StartDiditVerificationUseCase;
  let identityVerificationRepository: {
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let userRepository: { findOne: jest.Mock };
  let diditApiService: { createSession: jest.Mock };

  beforeEach(async () => {
    identityVerificationRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      findOneBy: jest.fn().mockResolvedValue({
        id: 'attempt-1',
        provider: IDENTITY_VERIFICATION_PROVIDER_ENUM.DIDIT,
        status: IDENTITY_VERIFICATION_STATUS_ENUM.PENDING,
        providerSessionId: DIDIT_SESSION.sessionId,
        providerMetadata: { hostedUrl: HOSTED_URL },
        expiresAt: DIDIT_SESSION.expiresAt,
      }),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'attempt-1', ...data })),
      update: jest.fn().mockResolvedValue(undefined),
    };
    userRepository = {
      findOne: jest.fn().mockResolvedValue({ id: USER_ID }),
    };
    diditApiService = {
      createSession: jest.fn().mockResolvedValue(DIDIT_SESSION),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StartDiditVerificationUseCase,
        {
          provide: getRepositoryToken(IdentityVerificationEntity),
          useValue: identityVerificationRepository,
        },
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        { provide: DiditApiService, useValue: diditApiService },
      ],
    }).compile();

    useCase = module.get(StartDiditVerificationUseCase);
  });

  it('crea el intento en PENDING antes de llamar a Didit', async () => {
    await useCase.execute(USER_ID, {});

    expect(identityVerificationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        provider: IDENTITY_VERIFICATION_PROVIDER_ENUM.DIDIT,
        status: IDENTITY_VERIFICATION_STATUS_ENUM.PENDING,
      }),
    );
  });

  it('persiste el session_id y el workflow devueltos por Didit', async () => {
    await useCase.execute(USER_ID, {});

    expect(identityVerificationRepository.update).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        providerSessionId: DIDIT_SESSION.sessionId,
        providerWorkflowId: DIDIT_SESSION.workflowId,
        startedAt: expect.any(Date),
      }),
    );
  });

  it('manda el userId como vendor_data para poder atribuir el webhook', async () => {
    await useCase.execute(USER_ID, {});

    expect(diditApiService.createSession).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String),
    );
  });

  it('devuelve la URL hospedada sin filtrar secretos del proveedor', async () => {
    const result = await useCase.execute(USER_ID, {});

    expect(result.url).toBe(HOSTED_URL);
    expect(Object.keys(result)).toEqual([
      'verificationId',
      'provider',
      'status',
      'sessionId',
      'url',
      'expiresAt',
      'reused',
    ]);
  });

  it('arma el callback pegando returnPath a la base del frontend', async () => {
    await useCase.execute(USER_ID, { returnPath: '/dashboard/identidad' });

    const [, callbackUrl] = diditApiService.createSession.mock.calls[0];
    expect(callbackUrl).toMatch(/\/dashboard\/identidad$/);
    expect(callbackUrl.startsWith('http')).toBe(true);
  });

  describe('reutilización de sesiones', () => {
    it('devuelve la sesión abierta y vigente en vez de crear otra', async () => {
      identityVerificationRepository.findOne.mockResolvedValue({
        id: 'attempt-previo',
        provider: IDENTITY_VERIFICATION_PROVIDER_ENUM.DIDIT,
        status: IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
        providerSessionId: 'ses_previa',
        providerMetadata: { hostedUrl: HOSTED_URL },
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const result = await useCase.execute(USER_ID, {});

      expect(result.reused).toBe(true);
      expect(diditApiService.createSession).not.toHaveBeenCalled();
      expect(identityVerificationRepository.save).not.toHaveBeenCalled();
    });

    it('crea una nueva si la anterior ya expiró', async () => {
      identityVerificationRepository.findOne.mockResolvedValue({
        id: 'attempt-previo',
        status: IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS,
        providerSessionId: 'ses_previa',
        providerMetadata: { hostedUrl: HOSTED_URL },
        expiresAt: new Date(Date.now() - 1_000),
      });

      const result = await useCase.execute(USER_ID, {});

      expect(result.reused).toBe(false);
      expect(diditApiService.createSession).toHaveBeenCalled();
    });

    it('crea una nueva si la anterior fue rechazada', async () => {
      identityVerificationRepository.findOne.mockResolvedValue({
        id: 'attempt-previo',
        status: IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED,
        providerSessionId: 'ses_previa',
        providerMetadata: { hostedUrl: HOSTED_URL },
        expiresAt: null,
      });

      await useCase.execute(USER_ID, {});

      expect(diditApiService.createSession).toHaveBeenCalled();
    });
  });

  it('rechaza con 409 si la identidad ya está aprobada', async () => {
    identityVerificationRepository.findOne.mockResolvedValue({
      id: 'attempt-previo',
      status: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
    });

    await expect(useCase.execute(USER_ID, {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(diditApiService.createSession).not.toHaveBeenCalled();
  });

  it('deja el intento en FAILED con el motivo si Didit no responde', async () => {
    diditApiService.createSession.mockRejectedValue(
      new DiditUnavailableException(),
    );

    await expect(useCase.execute(USER_ID, {})).rejects.toBeInstanceOf(
      DiditUnavailableException,
    );

    expect(identityVerificationRepository.update).toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({
        status: IDENTITY_VERIFICATION_STATUS_ENUM.FAILED,
        failureReason: expect.any(String),
        completedAt: expect.any(Date),
      }),
    );
  });

  it('lanza 404 si el usuario no existe', async () => {
    userRepository.findOne.mockResolvedValue(null);

    await expect(useCase.execute(USER_ID, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
