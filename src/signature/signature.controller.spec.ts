import { Test, TestingModule } from '@nestjs/testing';
import { SignatureController } from './signature.controller';
import { SignatureService } from './signature.service';
import { DeleteSignatureImageUseCase } from './applications/delete-signature-image.use-case';

describe('SignatureController', () => {
  let controller: SignatureController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SignatureController],
      providers: [
        {
          provide: SignatureService,
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            deactivate: jest.fn(),
            deleteSignatureImage: jest.fn(),
            deleteOfficialFile: jest.fn(),
            getFile: jest.fn(),
          },
        },
        {
          provide: DeleteSignatureImageUseCase,
          useValue: { execute: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<SignatureController>(SignatureController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
