import { Test, TestingModule } from '@nestjs/testing';
import { AccountsController } from './accounts.controller';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { GetMyAccountsUseCase } from './applications/get-my-accounts.use-case';

describe('AccountsController', () => {
  let controller: AccountsController;
  let getMyAccounts: { execute: jest.Mock };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    getMyAccounts = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [{ provide: GetMyAccountsUseCase, useValue: getMyAccounts }],
    }).compile();

    controller = module.get<AccountsController>(AccountsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  /** El catálogo es el del usuario del token: no hay parámetro con el que pedir el de otro. */
  it('getMe delega en GetMyAccountsUseCase con el userId del JWT', () => {
    controller.getMe(user);

    expect(getMyAccounts.execute).toHaveBeenCalledWith('user-1');
  });
});
