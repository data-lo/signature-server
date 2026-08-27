import { Test, TestingModule } from '@nestjs/testing';
import { SignatureController } from './signature.controller';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { GetSignatureFileUseCase } from './applications/get-signature-file.use-case';
import { GetSignatureUseCase } from './applications/get-signature.use-case';
import { UpdateSignatureUseCase } from './applications/update-signature.use-case';
import { DeactivateSignatureUseCase } from './applications/deactivate-signature.use-case';
import { DeleteSignatureImageUseCase } from './applications/delete-signature-image.use-case';
import { DeleteOfficialFileUseCase } from './applications/delete-official-file.use-case';

describe('SignatureController', () => {
  let controller: SignatureController;
  let getSignatureFile: { execute: jest.Mock };
  let getSignature: { execute: jest.Mock };
  let updateSignature: { execute: jest.Mock };
  let deactivateSignature: { execute: jest.Mock };
  let deleteSignatureImage: { execute: jest.Mock };
  let deleteOfficialFile: { execute: jest.Mock };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    getSignatureFile = { execute: jest.fn() };
    getSignature = { execute: jest.fn() };
    updateSignature = { execute: jest.fn() };
    deactivateSignature = { execute: jest.fn() };
    deleteSignatureImage = { execute: jest.fn() };
    deleteOfficialFile = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SignatureController],
      providers: [
        { provide: GetSignatureFileUseCase, useValue: getSignatureFile },
        { provide: GetSignatureUseCase, useValue: getSignature },
        { provide: UpdateSignatureUseCase, useValue: updateSignature },
        { provide: DeactivateSignatureUseCase, useValue: deactivateSignature },
        {
          provide: DeleteSignatureImageUseCase,
          useValue: deleteSignatureImage,
        },
        { provide: DeleteOfficialFileUseCase, useValue: deleteOfficialFile },
      ],
    }).compile();

    controller = module.get<SignatureController>(SignatureController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('getFile delega en GetSignatureFileUseCase', async () => {
    await controller.getFile(
      'object-key-1',
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );

    expect(getSignatureFile.execute).toHaveBeenCalledWith(
      'object-key-1',
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
  });

  it('findOne delega en GetSignatureUseCase', () => {
    controller.findOne('signature-1');

    expect(getSignature.execute).toHaveBeenCalledWith('signature-1');
  });

  /**
   * El controller aplana los arreglos de multer a un archivo por campo: el caso de uso trabaja
   * con "la imagen" y "la identificación", no con la forma que impone el multipart.
   */
  it('update aplana los archivos de multer y pasa el userId del JWT', () => {
    const signatureImage = { originalname: 'firma.png' } as Express.Multer.File;
    const officialFile = { originalname: 'ine.pdf' } as Express.Multer.File;

    controller.update(user, 'signature-1', {
      signatureImage: [signatureImage],
      officialFile: [officialFile],
    });

    expect(updateSignature.execute).toHaveBeenCalledWith(
      'signature-1',
      'user-1',
      { signatureImage, officialFile },
    );
  });

  it('update tolera una peticion sin archivos', () => {
    controller.update(user, 'signature-1', {});

    expect(updateSignature.execute).toHaveBeenCalledWith(
      'signature-1',
      'user-1',
      { signatureImage: undefined, officialFile: undefined },
    );
  });

  it('deactivate delega en DeactivateSignatureUseCase con el userId del JWT', () => {
    controller.deactivate(user, 'signature-1');

    expect(deactivateSignature.execute).toHaveBeenCalledWith(
      'signature-1',
      'user-1',
    );
  });

  it('deleteSignatureImageEndpoint delega en DeleteSignatureImageUseCase', () => {
    controller.deleteSignatureImageEndpoint(user, 'signature-1');

    expect(deleteSignatureImage.execute).toHaveBeenCalledWith(
      'signature-1',
      'user-1',
    );
  });

  it('deleteOfficialFileEndpoint delega en DeleteOfficialFileUseCase', () => {
    controller.deleteOfficialFileEndpoint(user, 'signature-1');

    expect(deleteOfficialFile.execute).toHaveBeenCalledWith(
      'signature-1',
      'user-1',
    );
  });
});
