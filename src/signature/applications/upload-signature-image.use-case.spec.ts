import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserEntity } from 'src/user/entities/user.entity';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { UpdateSigningCredentialStatusUseCase } from 'src/identity-verification/applications/update-signing-credential-status.use-case';
import { SignatureService } from '../signature.service';
import { UploadSignatureImageUseCase } from './upload-signature-image.use-case';

const USER_ID = 'user-1';
const S = SIGNING_CREDENTIAL_STATUS_ENUM;

const FILES = {
  signatureImage: [{ originalname: 'firma.png' } as Express.Multer.File],
};

describe('UploadSignatureImageUseCase', () => {
  let useCase: UploadSignatureImageUseCase;
  let userRepository: { findOne: jest.Mock };
  let signatureService: { create: jest.Mock };
  let updateSigningCredentialStatus: { execute: jest.Mock };

  function givenUserAt(status: SIGNING_CREDENTIAL_STATUS_ENUM): void {
    userRepository.findOne.mockResolvedValue({
      id: USER_ID,
      signingCredentialStatus: status,
    });
  }

  beforeEach(async () => {
    userRepository = { findOne: jest.fn() };
    signatureService = {
      create: jest.fn().mockResolvedValue({
        success: true,
        message: 'Firma registrada correctamente',
        data: { id: 'sig-1' },
      }),
    };
    updateSigningCredentialStatus = {
      execute: jest.fn().mockResolvedValue(S.CONFIGURED),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadSignatureImageUseCase,
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        { provide: SignatureService, useValue: signatureService },
        {
          provide: UpdateSigningCredentialStatusUseCase,
          useValue: updateSigningCredentialStatus,
        },
      ],
    }).compile();

    useCase = module.get(UploadSignatureImageUseCase);
  });

  describe('con la identidad ya aprobada (SIGNATURE_PENDING)', () => {
    beforeEach(() => givenUserAt(S.SIGNATURE_PENDING));

    it('registra la firma y deja la credencial en CONFIGURED', async () => {
      const result = await useCase.execute(USER_ID, {} as any, FILES);

      expect(signatureService.create).toHaveBeenCalledWith(USER_ID, {}, FILES);
      expect(updateSigningCredentialStatus.execute).toHaveBeenCalledWith(
        USER_ID,
        S.CONFIGURED,
      );
      expect(result.data).toEqual({ id: 'sig-1' });
    });

    it('no marca CONFIGURED si el alta de la firma falló', async () => {
      signatureService.create.mockRejectedValue(new Error('Minio caído'));

      await expect(useCase.execute(USER_ID, {} as any, FILES)).rejects.toThrow(
        'Minio caído',
      );

      expect(updateSigningCredentialStatus.execute).not.toHaveBeenCalled();
    });
  });

  describe('estados que bloquean la carga de la firma', () => {
    it.each([
      S.IDENTITY_VERIFICATION_REQUIRED,
      S.IDENTITY_VERIFICATION_PENDING,
      S.IDENTITY_VERIFICATION_IN_PROGRESS,
      S.IDENTITY_VERIFICATION_IN_REVIEW,
      S.IDENTITY_VERIFICATION_RETRY_REQUIRED,
      S.IDENTITY_VERIFICATION_FAILED,
      S.IDENTITY_VERIFICATION_MAX_ATTEMPTS_EXCEEDED,
      S.CONFIGURED,
    ])('rechaza con 403 en %s y no sube nada', async (status) => {
      givenUserAt(status);

      await expect(
        useCase.execute(USER_ID, {} as any, FILES),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // La guarda corre ANTES de tocar MinIO: un rechazo no puede dejar archivos huérfanos.
      expect(signatureService.create).not.toHaveBeenCalled();
      expect(updateSigningCredentialStatus.execute).not.toHaveBeenCalled();
    });

    it('explica el motivo concreto en vez de un 403 seco', async () => {
      givenUserAt(S.IDENTITY_VERIFICATION_IN_REVIEW);

      await expect(useCase.execute(USER_ID, {} as any, FILES)).rejects.toThrow(
        /en revisión/i,
      );
    });
  });

  it('lanza 404 si el usuario no existe', async () => {
    userRepository.findOne.mockResolvedValue(null);

    await expect(
      useCase.execute(USER_ID, {} as any, FILES),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
