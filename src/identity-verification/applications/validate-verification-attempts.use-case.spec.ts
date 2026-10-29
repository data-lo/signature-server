import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { IdentityVerificationEntity } from '../entities/identity-verification.entity';
import { IDENTITY_VERIFICATION_STATUS_ENUM } from '../enums/identity-verification-status.enum';
import { UpdateSigningCredentialStatusUseCase } from './update-signing-credential-status.use-case';
import {
  MAX_IDENTITY_VERIFICATION_ATTEMPTS,
  ValidateVerificationAttemptsUseCase,
} from './validate-verification-attempts.use-case';

const USER_ID = 'user-1';

describe('ValidateVerificationAttemptsUseCase', () => {
  let useCase: ValidateVerificationAttemptsUseCase;
  let identityVerificationRepository: { count: jest.Mock };
  let updateSigningCredentialStatus: { applyIfAllowed: jest.Mock };

  beforeEach(async () => {
    identityVerificationRepository = { count: jest.fn() };
    updateSigningCredentialStatus = {
      applyIfAllowed: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidateVerificationAttemptsUseCase,
        {
          provide: getRepositoryToken(IdentityVerificationEntity),
          useValue: identityVerificationRepository,
        },
        {
          provide: UpdateSigningCredentialStatusUseCase,
          useValue: updateSigningCredentialStatus,
        },
      ],
    }).compile();

    useCase = module.get(ValidateVerificationAttemptsUseCase);
  });

  it('devuelve los intentos restantes cuando todavía quedan', async () => {
    identityVerificationRepository.count.mockResolvedValue(1);

    await expect(useCase.execute(USER_ID)).resolves.toBe(
      MAX_IDENTITY_VERIFICATION_ATTEMPTS - 1,
    );

    expect(updateSigningCredentialStatus.applyIfAllowed).not.toHaveBeenCalled();
  });

  it('sólo cuenta los intentos que terminaron sin aprobación', async () => {
    identityVerificationRepository.count.mockResolvedValue(0);

    await useCase.execute(USER_ID);

    expect(identityVerificationRepository.count).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        status: In([
          IDENTITY_VERIFICATION_STATUS_ENUM.DECLINED,
          IDENTITY_VERIFICATION_STATUS_ENUM.ABANDONED,
          IDENTITY_VERIFICATION_STATUS_ENUM.EXPIRED,
          IDENTITY_VERIFICATION_STATUS_ENUM.FAILED,
        ]),
      },
    });
  });

  describe('con el tope agotado', () => {
    beforeEach(() => {
      identityVerificationRepository.count.mockResolvedValue(
        MAX_IDENTITY_VERIFICATION_ATTEMPTS,
      );
    });

    it('rechaza con 403', async () => {
      await expect(useCase.execute(USER_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('deja al usuario en MAX_ATTEMPTS_EXCEEDED, no sólo rechaza la llamada', async () => {
      await expect(useCase.execute(USER_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(updateSigningCredentialStatus.applyIfAllowed).toHaveBeenCalledWith(
        USER_ID,
        SIGNING_CREDENTIAL_STATUS_ENUM.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
      );
    });
  });
});
