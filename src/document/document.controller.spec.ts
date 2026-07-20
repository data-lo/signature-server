import { Test, TestingModule } from '@nestjs/testing';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('DocumentController', () => {
  let controller: DocumentController;
  let documentService: {
    create: jest.Mock;
    findWithFilters: jest.Mock;
    findDetailForUser: jest.Mock;
    getDocumentMinioURL: jest.Mock;
    assertUserHasAccess: jest.Mock;
    submitForAuthorization: jest.Mock;
    sign: jest.Mock;
    reject: jest.Mock;
    requestCancellation: jest.Mock;
    confirmCancellation: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    documentService = {
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
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [{ provide: DocumentService, useValue: documentService }],
    }).compile();

    controller = module.get<DocumentController>(DocumentController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('create delega en documentService.create con el userId y el X-Account-Id', async () => {
    const dto = { signerIds: ['user-2'], watcherIds: [] } as any;
    const file = { originalname: 'contrato.pdf' } as Express.Multer.File;

    await controller.create(user, 'account-1', dto, file, '127.0.0.1');

    expect(documentService.create).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      dto,
      file,
      '127.0.0.1',
    );
  });

  it('findAll delega en documentService.findWithFilters con el userId y el X-Account-Id', () => {
    const query = { page: 1, limit: 10 } as any;

    controller.findAll(user, 'account-1', query);

    expect(documentService.findWithFilters).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      query,
    );
  });
});
