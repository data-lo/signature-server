import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { UserEntity } from './entities/user.entity';
import { PersonalInformationEntity } from './entities/personal-information.entity';
import { SignatureService } from 'src/signature/signature.service';

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

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: getRepositoryToken(UserEntity),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(PersonalInformationEntity),
          useValue: createMockRepository(),
        },
        {
          provide: getDataSourceToken(),
          useValue: {
            createQueryRunner: jest.fn(),
          },
        },
        {
          provide: SignatureService,
          useValue: {
            findOne: jest.fn(),
            getFile: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
