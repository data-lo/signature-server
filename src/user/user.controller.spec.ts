import { Test, TestingModule } from '@nestjs/testing';
import { UserController } from './user.controller';
import { CreateUserUseCase } from './applications/create-user.use-case';
import { ListUsersUseCase } from './applications/list-users.use-case';
import { GetUserUseCase } from './applications/get-user.use-case';
import { UpdateUserUseCase } from './applications/update-user.use-case';
import { DeleteUserUseCase } from './applications/delete-user.use-case';

describe('UserController', () => {
  let controller: UserController;
  let createUser: { execute: jest.Mock };
  let listUsers: { execute: jest.Mock };
  let getUser: { execute: jest.Mock };
  let updateUser: { execute: jest.Mock };
  let deleteUser: { execute: jest.Mock };

  beforeEach(async () => {
    createUser = { execute: jest.fn() };
    listUsers = { execute: jest.fn() };
    getUser = { execute: jest.fn() };
    updateUser = { execute: jest.fn() };
    deleteUser = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        { provide: CreateUserUseCase, useValue: createUser },
        { provide: ListUsersUseCase, useValue: listUsers },
        { provide: GetUserUseCase, useValue: getUser },
        { provide: UpdateUserUseCase, useValue: updateUser },
        { provide: DeleteUserUseCase, useValue: deleteUser },
      ],
    }).compile();

    controller = module.get<UserController>(UserController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('create delega en CreateUserUseCase', () => {
    const dto = { email: 'juan@empresa.com' } as never;
    controller.create(dto);

    expect(createUser.execute).toHaveBeenCalledWith(dto);
  });

  /** El query param llega como texto: sólo la cadena "true" activa la resolución de archivos. */
  it('findAll traduce el query param withSignature a booleano', () => {
    controller.findAll('true');
    controller.findAll('false');
    controller.findAll();

    expect(listUsers.execute).toHaveBeenNthCalledWith(1, true);
    expect(listUsers.execute).toHaveBeenNthCalledWith(2, false);
    expect(listUsers.execute).toHaveBeenNthCalledWith(3, false);
  });

  it('findOne delega en GetUserUseCase con el id y withSignature', () => {
    controller.findOne('user-1', 'true');

    expect(getUser.execute).toHaveBeenCalledWith('user-1', true);
  });

  it('update delega en UpdateUserUseCase', () => {
    const dto = { firstName: 'Juan' };
    controller.update('user-1', dto);

    expect(updateUser.execute).toHaveBeenCalledWith('user-1', dto);
  });

  it('remove delega en DeleteUserUseCase', () => {
    controller.remove('user-1');

    expect(deleteUser.execute).toHaveBeenCalledWith('user-1');
  });
});
