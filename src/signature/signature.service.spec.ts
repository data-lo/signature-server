import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { SignatureService } from './signature.service';
import { SignatureEntity } from './entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { MinioService } from 'src/shared/minio/minio.service';
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

    /**
     * Bug reportado: borrar la firma y volver a dibujarla respondía "ya tiene una firma
     * registrada". `deleteSignatureImage` sólo borra la FILA —y con ella `user.signature_id`—
     * cuando la INE también está vacía; si el usuario tenía INE, la fila sobrevive con
     * `signature_object_key` en null y el usuario sigue apuntando a ella, así que este guard la
     * confundía con una firma existente y el alta quedaba bloqueada para siempre.
     */
    it('registra la firma reusando la fila que quedó sin imagen tras borrarla', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: 'signature-1',
      });
      signatureRepository.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: null,
        officialCardObjectKey: 'ine-object-key',
      });
      minioService.uploadObject.mockResolvedValue({
        status: 'FILE_CREATED',
        fileId: 'firma-nueva',
      });
      signatureRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.create('user-1', {} as any, {
        signatureImage: [{ originalname: 'firma.png' } as Express.Multer.File],
      });

      expect(result.success).toBe(true);
      // La INE que sobrevivió al borrado se conserva: no se estaba eliminando.
      expect(signatureRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'signature-1',
          signatureObjectKey: 'firma-nueva',
          officialCardObjectKey: 'ine-object-key',
          isActive: true,
        }),
      );
      // No se inserta una fila nueva ni se repunta al usuario: ya apuntaba a ésta.
      expect(signatureRepository.create).not.toHaveBeenCalled();
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('sigue rechazando el alta cuando la firma existente sí tiene imagen', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        signatureId: 'signature-1',
      });
      signatureRepository.findOne.mockResolvedValue({
        id: 'signature-1',
        signatureObjectKey: 'firma-vigente',
        officialCardObjectKey: null,
      });

      await expect(
        service.create('user-1', {} as any, {
          signatureImage: [
            { originalname: 'firma.png' } as Express.Multer.File,
          ],
        }),
      ).rejects.toThrow(ConflictException);

      // Se corta ANTES de subir nada: si no, quedaría un objeto huérfano en MinIO por cada
      // intento rechazado.
      expect(minioService.uploadObject).not.toHaveBeenCalled();
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

  describe('deleteSignatureImage', () => {
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

    it('deleteSignatureImage lanza BadRequestException si no hay imagen de firma que eliminar', async () => {
      mockOwnedSignature({ signatureObjectKey: null });

      await expect(
        service.deleteSignatureImage('signature-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(minioService.deleteFile).not.toHaveBeenCalled();
    });
  });
});
