import { Test, TestingModule } from '@nestjs/testing';
import { AccountsController } from './accounts.controller';
import { AccountService } from './account.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('AccountsController', () => {
  let controller: AccountsController;
  let accountService: { getAccountsCatalog: jest.Mock };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    accountService = { getAccountsCatalog: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [{ provide: AccountService, useValue: accountService }],
    }).compile();

    controller = module.get<AccountsController>(AccountsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('getMe delega en accountService.getAccountsCatalog con el userId del JWT', () => {
    controller.getMe(user);

    expect(accountService.getAccountsCatalog).toHaveBeenCalledWith('user-1');
  });
});
