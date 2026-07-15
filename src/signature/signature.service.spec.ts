import { InternalServerErrorException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SignatureService } from './signature.service';
import { SignatureEntity } from './entities/signature.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { MinioService } from 'src/shared/minio/minio.service';

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
      ],
    }).compile();

    service = module.get<SignatureService>(SignatureService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
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
  });
});
