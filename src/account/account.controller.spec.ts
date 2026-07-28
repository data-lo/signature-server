import { Test, TestingModule } from '@nestjs/testing';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('AccountController', () => {
  let controller: AccountController;
  let accountService: {
    create: jest.Mock;
    findAll: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    accountService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
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

  it('findOne delega en accountService.findOne con el userId del JWT', () => {
    controller.findOne(user, 'account-1');

    expect(accountService.findOne).toHaveBeenCalledWith('user-1', 'account-1');
  });

  it('update delega en accountService.update con el userId del JWT', () => {
    const dto = { name: 'Acme Renombrada' };
    controller.update(user, 'account-1', dto);

    expect(accountService.update).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      dto,
    );
  });
});
