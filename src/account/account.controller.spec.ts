import { Test, TestingModule } from '@nestjs/testing';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('AccountController', () => {
  let controller: AccountController;
  let accountService: {
    create: jest.Mock;
    createOrganization: jest.Mock;
    findAll: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    getAccountsCatalog: jest.Mock;
  };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    jti: 'jti-1',
  };

  beforeEach(async () => {
    accountService = {
      create: jest.fn(),
      createOrganization: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      getAccountsCatalog: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [{ provide: AccountService, useValue: accountService }],
    }).compile();

    controller = module.get<AccountController>(AccountController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('createOrganization delega en accountService.createOrganization con el userId del JWT', () => {
    const dto = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };
    controller.createOrganization(user, dto);

    expect(accountService.createOrganization).toHaveBeenCalledWith(
      'user-1',
      dto,
    );
  });

  it('getAccountsCatalog delega en accountService.getAccountsCatalog con el userId del JWT', () => {
    controller.getAccountsCatalog(user);

    expect(accountService.getAccountsCatalog).toHaveBeenCalledWith('user-1');
  });
});
