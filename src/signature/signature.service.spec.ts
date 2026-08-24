import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { SignatureService } from './signature.service';
import { SignatureEntity } from './entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { MinioService } from 'src/shared/minio/minio.service';
import { SIGNING_CREDENTIAL_STATUS_ENUM } from 'src/user/enums/signing-credential-status.enum';
import { UpdateSigningCredentialStatusUseCase } from 'src/identity-verification/applications/update-signing-credential-status.use-case';
import {
  MAX_IMAGE_FILE_SIZE_BYTES,
  MAX_PDF_FILE_SIZE_BYTES,
} from 'src/shared/constants/file-upload.constants';

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

describe('SignatureService', () => {
  let service: SignatureService;
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

    service = module.get<SignatureService>(SignatureService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('no decide sobre el estado de la credencial: eso es del caso de uso', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: null,
      });
      minioService.uploadObject.mockResolvedValue({
        status: 'FILE_CREATED',
        fileId: 'signature-object-key',
      });
      signatureRepository.create.mockImplementation((data) => data);
      signatureRepository.save.mockResolvedValue({ id: 'signature-1' });

      await service.create('user-1', {} as any, {
        signatureImage: [{ originalname: 'firma.png' } as Express.Multer.File],
      });

      expect(updateSigningCredentialStatus.execute).not.toHaveBeenCalled();
      expect(
        updateSigningCredentialStatus.applyIfAllowed,
      ).not.toHaveBeenCalled();
    });

    it('crea la firma solo con la imagen de firma, sin INE', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: null,
      });
      minioService.uploadObject.mockResolvedValue({
        status: 'FILE_CREATED',
        fileId: 'signature-object-key',
      });
      signatureRepository.create.mockImplementation((data) => data);
      signatureRepository.save.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'signature-object-key',
        officialCardObjectKey: null,
      });

      const result = await service.create('user-1', {} as any, {
        signatureImage: [{ originalname: 'firma.png' } as Express.Multer.File],
      });

      expect(minioService.uploadObject).toHaveBeenCalledTimes(1);
      expect(userRepository.update).toHaveBeenCalledWith('user-1', {
        signatureId: 'signature-1',
      });
      expect(result.success).toBe(true);
    });

    it('lanza error si se envía INE pero su subida a Minio falla', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: null,
      });
      minioService.uploadObject
        .mockResolvedValueOnce({
          status: 'FILE_CREATED',
          fileId: 'signature-object-key',
        })
        .mockResolvedValueOnce({ status: 'FILE_ERROR' });

      await expect(
        service.create('user-1', {} as any, {
          signatureImage: [
            { originalname: 'firma.png' } as Express.Multer.File,
          ],
          officialFile: [{ originalname: 'ine.pdf' } as Express.Multer.File],
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('lanza BadRequestException si la imagen de firma excede el límite de tamaño', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: null,
      });

      await expect(
        service.create('user-1', {} as any, {
          signatureImage: [
            {
              originalname: 'firma.png',
              size: MAX_IMAGE_FILE_SIZE_BYTES + 1,
            } as Express.Multer.File,
          ],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('lanza BadRequestException si la identificación oficial excede el límite de tamaño', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: null,
      });

      await expect(
        service.create('user-1', {} as any, {
          signatureImage: [
            { originalname: 'firma.png', size: 1000 } as Express.Multer.File,
          ],
          officialFile: [
            {
              originalname: 'ine.pdf',
              size: MAX_PDF_FILE_SIZE_BYTES + 1,
            } as Express.Multer.File,
          ],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.uploadObject).not.toHaveBeenCalled();
    });

    it('permite archivos justo en el límite de tamaño', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: null,
      });
      minioService.uploadObject.mockResolvedValue({
        status: 'FILE_CREATED',
        fileId: 'signature-object-key',
      });
      signatureRepository.create.mockImplementation((data) => data);
      signatureRepository.save.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'signature-object-key',
        officialCardObjectKey: null,
      });

      await expect(
        service.create('user-1', {} as any, {
          signatureImage: [
            {
              originalname: 'firma.png',
              size: MAX_IMAGE_FILE_SIZE_BYTES,
            } as Express.Multer.File,
          ],
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('update', () => {
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

      await service.update('signature-1', 'user-1', {
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

      await service.update('signature-1', 'user-1', {
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

      await service.update('signature-1', 'user-1', {
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

      await service.update('signature-1', 'user-1', {
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
        service.update('signature-1', 'user-1', {
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
        service.update('signature-1', 'user-1', {
          officialFile: {
            originalname: 'ine.pdf',
            size: MAX_PDF_FILE_SIZE_BYTES + 1,
          } as Express.Multer.File,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.replaceFile).not.toHaveBeenCalled();
    });
  });

  describe('deleteSignatureImage / deleteOfficialFile', () => {
    function mockOwnedSignature(overrides: Partial<SignatureEntity> = {}) {
      const signature = {
        id: 'signature-1',
        signatureObjectKey: 'sig-key',
        officialCardObjectKey: 'ine-key',
        ...overrides,
      };
      signatureRepository.findOne.mockResolvedValue(signature);
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: 'signature-1',
      });
      return signature;
    }

    it('deleteSignatureImage: si la INE todavía existe, solo limpia signatureObjectKey (no borra la fila)', async () => {
      mockOwnedSignature();
      manager.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'sig-key',
        officialCardObjectKey: 'ine-key',
      });

      await service.deleteSignatureImage('signature-1', 'user-1');

      expect(minioService.deleteFile).toHaveBeenCalledWith(
        'sig-key',
        expect.anything(),
      );
      expect(manager.update).toHaveBeenCalledWith(
        SignatureEntity,
        { id: 'signature-1' },
        { signatureObjectKey: null },
      );
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it('deleteSignatureImage: si la INE ya estaba vacía, borra la fila completa y limpia user.signatureId', async () => {
      mockOwnedSignature();
      // Estado FRESCO leído dentro de la transacción (con lock) — officialCardObjectKey ya null.
      manager.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'sig-key',
        officialCardObjectKey: null,
      });

      await service.deleteSignatureImage('signature-1', 'user-1');

      expect(manager.delete).toHaveBeenCalledWith(SignatureEntity, {
        id: 'signature-1',
      });
      expect(manager.update).toHaveBeenCalledWith(UserEntity, 'user-1', {
        signatureId: null,
      });
    });

    it('bug corregido: dos eliminaciones casi simultáneas (firma + INE) no dejan una fila huérfana', async () => {
      // Simula la condición de carrera: cuando esta transacción adquiere el lock, la OTRA
      // eliminación (INE) ya corrió y confirmó — el lock pesimista garantiza que esta lectura
      // vea ese estado fresco (officialCardObjectKey ya en null), no el que había cuando
      // deleteSignatureImage() leyó `signature` al principio del método (mockOwnedSignature).
      mockOwnedSignature({ officialCardObjectKey: 'ine-key' });
      manager.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'sig-key',
        officialCardObjectKey: null,
      });

      await service.deleteSignatureImage('signature-1', 'user-1');

      // Debe tomar la rama de "borrar todo", no la de "solo limpiar mi campo" — sin esto, la
      // fila queda huérfana (ambos object keys en null, pero user.signatureId sigue apuntando
      // ahí) y el usuario no puede volver a registrar una firma nunca más.
      expect(manager.delete).toHaveBeenCalledWith(SignatureEntity, {
        id: 'signature-1',
      });
      expect(manager.update).toHaveBeenCalledWith(UserEntity, 'user-1', {
        signatureId: null,
      });
    });

    it('deleteOfficialFile: si la firma todavía existe, solo limpia officialCardObjectKey', async () => {
      mockOwnedSignature();
      manager.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'sig-key',
        officialCardObjectKey: 'ine-key',
      });

      await service.deleteOfficialFile('signature-1', 'user-1');

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

    it('deleteSignatureImage lanza BadRequestException si no hay imagen de firma que eliminar', async () => {
      mockOwnedSignature({ signatureObjectKey: null });

      await expect(
        service.deleteSignatureImage('signature-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.deleteFile).not.toHaveBeenCalled();
    });

    it('deleteOfficialFile lanza BadRequestException si no hay identificación que eliminar', async () => {
      mockOwnedSignature({ officialCardObjectKey: null });

      await expect(
        service.deleteOfficialFile('signature-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.deleteFile).not.toHaveBeenCalled();
    });
  });
});
