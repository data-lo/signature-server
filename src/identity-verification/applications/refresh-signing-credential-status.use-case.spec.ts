import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { RedisService } from 'src/shared/redis/redis.service';
import { RefreshSigningCredentialStatusUseCase } from './refresh-signing-credential-status.use-case';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';

const USER_ID = 'user-1';
const CURP = 'CURP0000000000AB';

describe('RefreshSigningCredentialStatusUseCase', () => {
  let useCase: RefreshSigningCredentialStatusUseCase;
  let userRepository: { findOne: jest.Mock; update: jest.Mock };
  let identityVerificationRepository: { exists: jest.Mock };
  let redisService: { del: jest.Mock };

  function givenUser(overrides: Partial<UserEntity> = {}) {
    userRepository.findOne.mockResolvedValue({
      id: USER_ID,
      nationalId: CURP,
      signatureId: null,
      signingCredentialConfigured: false,
      ...overrides,
    });
  }

  beforeEach(async () => {
    userRepository = { findOne: jest.fn(), update: jest.fn() };
    identityVerificationRepository = { exists: jest.fn() };
    redisService = { del: jest.fn().mockResolvedValue(1) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshSigningCredentialStatusUseCase,
        {
          provide: getRepositoryToken(UserEntity),
          useValue: userRepository,
        },
        {
          provide: getRepositoryToken(IdentityVerificationEntity),
          useValue: identityVerificationRepository,
        },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    useCase = module.get(RefreshSigningCredentialStatusUseCase);
  });

  describe('la regla: identidad APPROVED Y firma PNG registrada', () => {
    it('marca la credencial como configurada cuando se cumplen ambas', async () => {
      givenUser({ signatureId: 'sig-1' });
      identityVerificationRepository.exists.mockResolvedValue(true);

      await expect(useCase.execute(USER_ID)).resolves.toBe(true);

      expect(userRepository.update).toHaveBeenCalledWith(USER_ID, {
        signingCredentialConfigured: true,
      });
    });

    it('no la configura con identidad aprobada pero sin firma PNG', async () => {
      givenUser({ signatureId: null });
      identityVerificationRepository.exists.mockResolvedValue(true);

      await expect(useCase.execute(USER_ID)).resolves.toBe(false);
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('no la configura con firma PNG pero sin identidad aprobada', async () => {
      givenUser({ signatureId: 'sig-1' });
      identityVerificationRepository.exists.mockResolvedValue(false);

      await expect(useCase.execute(USER_ID)).resolves.toBe(false);
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('la revierte a false si deja de cumplirse alguna condición', async () => {
      givenUser({ signatureId: null, signingCredentialConfigured: true });
      identityVerificationRepository.exists.mockResolvedValue(true);

      await expect(useCase.execute(USER_ID)).resolves.toBe(false);

      expect(userRepository.update).toHaveBeenCalledWith(USER_ID, {
        signingCredentialConfigured: false,
      });
    });
  });

  it('sólo consulta verificaciones APPROVED del usuario', async () => {
    givenUser({ signatureId: 'sig-1' });
    identityVerificationRepository.exists.mockResolvedValue(true);

    await useCase.execute(USER_ID);

    expect(identityVerificationRepository.exists).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        status: IDENTITY_VERIFICATION_STATUS_ENUM.APPROVED,
      },
    });
  });

  it('no escribe si la bandera ya tiene el valor correcto', async () => {
    givenUser({ signatureId: 'sig-1', signingCredentialConfigured: true });
    identityVerificationRepository.exists.mockResolvedValue(true);

    await useCase.execute(USER_ID);

    expect(userRepository.update).not.toHaveBeenCalled();
  });

  it('invalida el snapshot de perfil para que /users/me no quede obsoleto', async () => {
    givenUser({ signatureId: 'sig-1' });
    identityVerificationRepository.exists.mockResolvedValue(true);

    await useCase.execute(USER_ID);

    expect(redisService.del).toHaveBeenCalledWith(CURP);
  });

  it('no tumba la operación si Redis falla al invalidar', async () => {
    givenUser({ signatureId: 'sig-1' });
    identityVerificationRepository.exists.mockResolvedValue(true);
    redisService.del.mockRejectedValue(new Error('Redis caído'));

    await expect(useCase.execute(USER_ID)).resolves.toBe(true);
    expect(userRepository.update).toHaveBeenCalled();
  });

  it('devuelve false sin escribir si el usuario no existe', async () => {
    userRepository.findOne.mockResolvedValue(null);

    await expect(useCase.execute(USER_ID)).resolves.toBe(false);
    expect(userRepository.update).not.toHaveBeenCalled();
  });
});
