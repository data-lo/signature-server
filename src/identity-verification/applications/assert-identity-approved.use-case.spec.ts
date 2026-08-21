import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AssertIdentityApprovedUseCase } from './assert-identity-approved.use-case';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';

const USER_ID = 'user-1';

describe('AssertIdentityApprovedUseCase', () => {
  let useCase: AssertIdentityApprovedUseCase;
  let repository: { exists: jest.Mock; findOne: jest.Mock };

  beforeEach(async () => {
    repository = { exists: jest.fn(), findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssertIdentityApprovedUseCase,
        {
          provide: getRepositoryToken(IdentityVerificationEntity),
          useValue: repository,
        },
      ],
    }).compile();

    useCase = module.get(AssertIdentityApprovedUseCase);
  });

  it('deja pasar al usuario con una verificación APPROVED', async () => {
    repository.exists.mockResolvedValue(true);

    await expect(useCase.execute(USER_ID)).resolves.toBeUndefined();
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('deja pasar aunque el intento más reciente sea uno abandonado después de aprobar', async () => {
    // Una aprobación previa no caduca porque el usuario arranque otro intento y lo deje a medias.
    repository.exists.mockResolvedValue(true);
    repository.findOne.mockResolvedValue({
      status: IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED,
    });

    await expect(useCase.execute(USER_ID)).resolves.toBeUndefined();
  });

  it('bloquea con 403 al usuario que nunca inició una verificación', async () => {
    repository.exists.mockResolvedValue(false);
    repository.findOne.mockResolvedValue(null);

    await expect(useCase.execute(USER_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it.each([
    [IDENTITY_VERIFICATION_STATUS_ENUM.IN_PROGRESS, 'en curso'],
    [IDENTITY_VERIFICATION_STATUS_ENUM.IN_REVIEW, 'en revisión'],
    [IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED, 'No fue posible validar'],
    [IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED, 'expiró'],
  ])(
    'explica el motivo cuando el último intento está en %s',
    async (status, expectedFragment) => {
      repository.exists.mockResolvedValue(false);
      repository.findOne.mockResolvedValue({ status });

      await expect(useCase.execute(USER_ID)).rejects.toThrow(expectedFragment);
    },
  );
});
