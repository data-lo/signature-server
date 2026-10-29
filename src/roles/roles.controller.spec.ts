import { Test, TestingModule } from '@nestjs/testing';
import { RolesController } from './roles.controller';
import { GetSystemRolesUseCase } from './applications/get-system-roles.use-case';

describe('RolesController', () => {
  let controller: RolesController;
  let getSystemRoles: { execute: jest.Mock };

  beforeEach(async () => {
    getSystemRoles = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RolesController],
      providers: [{ provide: GetSystemRolesUseCase, useValue: getSystemRoles }],
    }).compile();

    controller = module.get<RolesController>(RolesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('findAllSystemRoles delega en GetSystemRolesUseCase', () => {
    const response = {
      success: true,
      message: 'ok',
      data: [{ id: 'role-1', name: 'ADMIN', isSystemRole: true }],
    };
    getSystemRoles.execute.mockReturnValue(response);

    const result = controller.findAllSystemRoles();

    expect(getSystemRoles.execute).toHaveBeenCalledWith();
    expect(result).toBe(response);
  });
});
