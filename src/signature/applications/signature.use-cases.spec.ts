import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { SignatureService } from '../signature.service';
import { SignatureEntity } from '../entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { MinioService } from 'src/shared/minio/minio.service';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { UpdateSigningCredentialStatusUseCase } from 'src/identity-verification/applications/update-signing-credential-status.use-case';
import {
  MAX_IMAGE_FILE_SIZE_BYTES,
  MAX_PDF_FILE_SIZE_BYTES,
} from 'src/shared/constants/file-upload.constants';

import { UpdateSignatureUseCase } from './update-signature.use-case';
import { DeactivateSignatureUseCase } from './deactivate-signature.use-case';
import { DeleteOfficialFileUseCase } from './delete-official-file.use-case';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
}

/**
 * Los casos de uso se montan sobre el `SignatureService` real con repositorios y MinIO
 * simulados: lo que se prueba es la secuencia —comprobar propiedad y tamaños antes de subir
 * nada, y decidir qué pasa con la credencial del usuario— y con el servicio simulado no
 * quedaría nada de eso bajo prueba.
 */
describe('casos de uso de la firma del usuario', () => {
  let updateSignature: UpdateSignatureUseCase;
  let deactivateSignature: DeactivateSignatureUseCase;
  let deleteOfficialFile: DeleteOfficialFileUseCase;
  let signatureRepository: ReturnType<typeof createMockRepository>;
  let userRepository: ReturnType<typeof createMockRepository>;
  let minioService: {
    uploadObject: jest.Mock;
    getFile: jest.Mock;
    getFileInBytesFormat: jest.Mock;
    deleteFile: jest.Mock;
    replaceFile: jest.Mock;
  };
  let manager: { findOne: jest.Mock; delete: jest.Mock; update: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let updateSigningCredentialStatus: {
    execute: jest.Mock;
    applyIfAllowed: jest.Mock;
  };

  beforeEach(async () => {
    signatureRepository = createMockRepository();
    userRepository = createMockRepository();
    minioService = {
      uploadObject: jest.fn(),
      getFile: jest.fn(),
      getFileInBytesFormat: jest.fn(),
      deleteFile: jest.fn(),
      replaceFile: jest.fn(),
    };
    manager = { findOne: jest.fn(), delete: jest.fn(), update: jest.fn() };
    dataSource = {
      transaction: jest.fn((callback) => callback(manager)),
    };
    // Estas pruebas cubren el manejo de archivos. La regla de estados vive en los casos de uso
    // (`UploadSignatureImageUseCase`, `DeleteSignatureImageUseCase`) y se prueba allá.
    updateSigningCredentialStatus = {
      execute: jest.fn().mockResolvedValue(undefined),
      applyIfAllowed: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SignatureService,
        UpdateSignatureUseCase,
        DeactivateSignatureUseCase,
        DeleteOfficialFileUseCase,
        {
          provide: getRepositoryToken(SignatureEntity),
          useValue: signatureRepository,
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: userRepository,
        },
        {
          provide: MinioService,
          useValue: minioService,
        },
        {
          provide: getDataSourceToken(),
          useValue: dataSource,
        },
        {
          provide: UpdateSigningCredentialStatusUseCase,
          useValue: updateSigningCredentialStatus,
        },
      ],
    }).compile();

    updateSignature = module.get(UpdateSignatureUseCase);
    deactivateSignature = module.get(DeactivateSignatureUseCase);
    deleteOfficialFile = module.get(DeleteOfficialFileUseCase);
  });

  describe('UpdateSignatureUseCase', () => {
    function mockOwnedSignature(overrides: Partial<SignatureEntity> = {}) {
      signatureRepository.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'existing-signature-key',
        officialCardObjectKey: 'existing-ine-key',
        isActive: true,
        ...overrides,
      });
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: 'signature-1',
      });
    }

    it('reemplaza la imagen de firma existente pasando el originalname correcto a Minio (bug .fieldname/.filename corregido)', async () => {
      mockOwnedSignature();
      minioService.replaceFile.mockResolvedValue({});

      await updateSignature.execute('signature-1', 'user-1', {
        signatureImage: {
          fieldname: 'signatureImage',
          originalname: 'nueva-firma.png',
          size: 1000,
        } as Express.Multer.File,
      });

      expect(minioService.replaceFile).toHaveBeenCalledWith(
        'existing-signature-key',
        expect.objectContaining({ name: 'nueva-firma.png' }),
        expect.anything(),
      );
    });

    it('repone la credencial a CONFIGURED al volver a subir la firma PNG', async () => {
      mockOwnedSignature();
      minioService.replaceFile.mockResolvedValue({});

      await updateSignature.execute('signature-1', 'user-1', {
        signatureImage: {
          originalname: 'nueva-firma.png',
          size: 1000,
        } as Express.Multer.File,
      });

      // `applyIfAllowed` y no `execute`: si el usuario ya estaba CONFIGURED es un no-op, y si su
      // identidad dejó de estar aprobada no se le devuelve la credencial por la puerta de atrás.
      expect(updateSigningCredentialStatus.applyIfAllowed).toHaveBeenCalledWith(
        'user-1',
        SIGNING_CREDENTIAL_STATUS_ENUM.CONFIGURED,
      );
    });

    it('no toca la credencial si sólo se actualizó la identificación oficial', async () => {
      mockOwnedSignature();
      minioService.replaceFile.mockResolvedValue({});

      await updateSignature.execute('signature-1', 'user-1', {
        officialFile: {
          originalname: 'nueva-ine.pdf',
          size: 1000,
        } as Express.Multer.File,
      });

      expect(
        updateSigningCredentialStatus.applyIfAllowed,
      ).not.toHaveBeenCalled();
    });

    it('reemplaza la identificación oficial existente pasando el originalname correcto a Minio (bug .fieldname/.filename corregido)', async () => {
      mockOwnedSignature();
      minioService.replaceFile.mockResolvedValue({});

      await updateSignature.execute('signature-1', 'user-1', {
        officialFile: {
          fieldname: 'officialFile',
          originalname: 'nueva-ine.pdf',
          size: 1000,
        } as Express.Multer.File,
      });

      expect(minioService.replaceFile).toHaveBeenCalledWith(
        'existing-ine-key',
        expect.objectContaining({ name: 'nueva-ine.pdf' }),
        expect.anything(),
      );
    });

    it('lanza BadRequestException si la nueva imagen de firma excede el límite de tamaño', async () => {
      mockOwnedSignature();

      await expect(
        updateSignature.execute('signature-1', 'user-1', {
          signatureImage: {
            originalname: 'firma.png',
            size: MAX_IMAGE_FILE_SIZE_BYTES + 1,
          } as Express.Multer.File,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.replaceFile).not.toHaveBeenCalled();
    });

    it('lanza BadRequestException si la nueva identificación oficial excede el límite de tamaño', async () => {
      mockOwnedSignature();

      await expect(
        updateSignature.execute('signature-1', 'user-1', {
          officialFile: {
            originalname: 'ine.pdf',
            size: MAX_PDF_FILE_SIZE_BYTES + 1,
          } as Express.Multer.File,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.replaceFile).not.toHaveBeenCalled();
    });
  });

  describe('DeactivateSignatureUseCase', () => {
    function mockOwnedSignature(overrides = {}) {
      signatureRepository.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'existing-signature-key',
        officialCardObjectKey: 'existing-ine-key',
        isActive: true,
        ...overrides,
      });
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: 'signature-1',
      });
    }

    /**
     * El objeto se sobrescribe en lugar de borrarse: los documentos ya firmados apuntan a esa
     * misma key y borrarla los dejaría sin imagen de firma.
     */
    it('sobrescribe el PNG con una imagen transparente en vez de borrarlo', async () => {
      mockOwnedSignature();
      minioService.replaceFile.mockResolvedValue({});
      minioService.getFile.mockResolvedValue({
        secureUrl: 'https://minio/blank.png',
        expiresIn: 3600,
      });

      const result = await deactivateSignature.execute('signature-1', 'user-1');

      expect(minioService.replaceFile).toHaveBeenCalledWith(
        'existing-signature-key',
        expect.objectContaining({ name: 'blank.png', mimetype: 'image/png' }),
        expect.anything(),
      );
      expect(minioService.deleteFile).not.toHaveBeenCalled();
      expect(signatureRepository.update).toHaveBeenCalledWith(
        { id: 'signature-1' },
        { isActive: false },
      );
      expect(result.data).toMatchObject({
        id: 'signature-1',
        secureUrl: 'https://minio/blank.png',
      });
    });

    it('lanza BadRequestException si la firma ya estaba desactivada', async () => {
      mockOwnedSignature({ isActive: false });

      await expect(
        deactivateSignature.execute('signature-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.replaceFile).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si la firma no es del usuario autenticado', async () => {
      signatureRepository.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'existing-signature-key',
        isActive: true,
      });
      userRepository.findOne.mockResolvedValue({
        id: 'otro-user',
        signatureId: 'otra-firma',
      });

      await expect(
        deactivateSignature.execute('signature-1', 'otro-user'),
      ).rejects.toThrow(ForbiddenException);
      expect(minioService.replaceFile).not.toHaveBeenCalled();
    });
  });

  describe('DeleteOfficialFileUseCase', () => {
    function mockOwnedSignature(overrides = {}) {
      signatureRepository.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'sig-key',
        officialCardObjectKey: 'ine-key',
        isActive: true,
        ...overrides,
      });
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: 'signature-1',
      });
    }

    it('si la firma todavia existe, solo limpia officialCardObjectKey', async () => {
      mockOwnedSignature();
      manager.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'sig-key',
        officialCardObjectKey: 'ine-key',
      });

      await deleteOfficialFile.execute('signature-1', 'user-1');

      expect(minioService.deleteFile).toHaveBeenCalledWith(
        'ine-key',
        expect.anything(),
      );
      expect(manager.update).toHaveBeenCalledWith(
        SignatureEntity,
        { id: 'signature-1' },
        { officialCardObjectKey: null },
      );
      expect(manager.delete).not.toHaveBeenCalled();
    });

    /**
     * Una fila sin imagen ni identificación bloquearía para siempre el alta de una firma nueva,
     * porque `create` la vería como "ya tienes una firma registrada".
     */
    it('si la firma tambien estaba vacia, borra la fila y suelta users.signature_id', async () => {
      mockOwnedSignature({ signatureObjectKey: null });
      manager.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: null,
        officialCardObjectKey: 'ine-key',
      });

      await deleteOfficialFile.execute('signature-1', 'user-1');

      expect(manager.update).toHaveBeenCalledWith(UserEntity, 'user-1', {
        signatureId: null,
      });
      expect(manager.delete).toHaveBeenCalledWith(SignatureEntity, {
        id: 'signature-1',
      });
    });

    it('lanza BadRequestException si no hay identificacion que eliminar', async () => {
      mockOwnedSignature({ officialCardObjectKey: null });

      await expect(
        deleteOfficialFile.execute('signature-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.deleteFile).not.toHaveBeenCalled();
    });
  });
});
