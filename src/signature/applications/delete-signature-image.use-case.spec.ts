import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { UpdateSigningCredentialStatusUseCase } from 'src/identity-verification/applications/update-signing-credential-status.use-case';
import { SignatureService } from '../signature.service';
import { DeleteSignatureImageUseCase } from './delete-signature-image.use-case';

const USER_ID = 'user-1';
const SIGNATURE_ID = 'sig-1';

describe('DeleteSignatureImageUseCase', () => {
  let useCase: DeleteSignatureImageUseCase;
  let signatureService: { deleteSignatureImage: jest.Mock };
  let updateSigningCredentialStatus: { applyIfAllowed: jest.Mock };

  beforeEach(async () => {
    signatureService = {
      deleteSignatureImage: jest.fn().mockResolvedValue({
        success: true,
        message: 'Imagen de firma eliminada correctamente',
        data: null,
      }),
    };
    updateSigningCredentialStatus = {
      applyIfAllowed: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeleteSignatureImageUseCase,
        { provide: SignatureService, useValue: signatureService },
        {
          provide: UpdateSigningCredentialStatusUseCase,
          useValue: updateSigningCredentialStatus,
        },
      ],
    }).compile();

    useCase = module.get(DeleteSignatureImageUseCase);
  });

  it('devuelve al usuario a SIGNATURE_PENDING: la identidad sigue aprobada', async () => {
    const result = await useCase.execute(SIGNATURE_ID, USER_ID);

    expect(signatureService.deleteSignatureImage).toHaveBeenCalledWith(
      SIGNATURE_ID,
      USER_ID,
    );
    expect(updateSigningCredentialStatus.applyIfAllowed).toHaveBeenCalledWith(
      USER_ID,
      SIGNING_CREDENTIAL_STATUS_ENUM.SIGNATURE_PENDING,
    );
    expect(result.success).toBe(true);
  });

  it('no toca el estado si el borrado falló', async () => {
    signatureService.deleteSignatureImage.mockRejectedValue(
      new BadRequestException('No hay una imagen de firma registrada'),
    );

    await expect(useCase.execute(SIGNATURE_ID, USER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(updateSigningCredentialStatus.applyIfAllowed).not.toHaveBeenCalled();
  });
});
