import { Test, TestingModule } from '@nestjs/testing';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';

describe('DocumentController', () => {
  let controller: DocumentController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [
        {
          provide: DocumentService,
          useValue: {
            create: jest.fn(),
            findWithFilters: jest.fn(),
            findDetailForUser: jest.fn(),
            getDocumentMinioURL: jest.fn(),
            assertUserHasAccess: jest.fn(),
            submitForAuthorization: jest.fn(),
            sign: jest.fn(),
            reject: jest.fn(),
            requestCancellation: jest.fn(),
            confirmCancellation: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<DocumentController>(DocumentController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
