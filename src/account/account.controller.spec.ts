import { Test, TestingModule } from '@nestjs/testing';
import { AccountController } from './account.controller';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { CreateAccountUseCase } from './applications/create-account.use-case';
import { ListAccountsUseCase } from './applications/list-accounts.use-case';
import { GetAccountUseCase } from './applications/get-account.use-case';
import { UpdateAccountUseCase } from './applications/update-account.use-case';

describe('AccountController', () => {
  let controller: AccountController;
  let createAccount: { execute: jest.Mock };
  let listAccounts: { execute: jest.Mock };
  let getAccount: { execute: jest.Mock };
  let updateAccount: { execute: jest.Mock };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    createAccount = { execute: jest.fn() };
    listAccounts = { execute: jest.fn() };
    getAccount = { execute: jest.fn() };
    updateAccount = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [
        { provide: CreateAccountUseCase, useValue: createAccount },
        { provide: ListAccountsUseCase, useValue: listAccounts },
        { provide: GetAccountUseCase, useValue: getAccount },
        { provide: UpdateAccountUseCase, useValue: updateAccount },
      ],
    }).compile();

    controller = module.get<AccountController>(AccountController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('create delega en CreateAccountUseCase con el userId del JWT', () => {
    const dto = { name: 'Acme' };
    controller.create(user, dto as never);

    expect(createAccount.execute).toHaveBeenCalledWith('user-1', dto);
  });

  it('findAll delega en ListAccountsUseCase', () => {
    controller.findAll();

    expect(listAccounts.execute).toHaveBeenCalledWith();
  });

  it('findOne delega en GetAccountUseCase con el userId del JWT', () => {
    controller.findOne(user, 'account-1');

    expect(getAccount.execute).toHaveBeenCalledWith('user-1', 'account-1');
  });

  it('update delega en UpdateAccountUseCase con el userId del JWT', () => {
    const dto = { name: 'Acme Renombrada' };
    controller.update(user, 'account-1', dto);

    expect(updateAccount.execute).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      dto,
    );
  });
});
