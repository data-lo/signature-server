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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SignatureService,
        {
          provide: getRepositoryToken(SignatureEntity),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: createMockRepository(),
        },
        {
          provide: MinioService,
          useValue: {
            uploadObject: jest.fn(),
            getFile: jest.fn(),
            getFileInBytesFormat: jest.fn(),
            deleteFile: jest.fn(),
            replaceFile: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SignatureService>(SignatureService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
