import { Test, TestingModule } from '@nestjs/testing';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

describe('RolesController', () => {
  let controller: RolesController;
  let rolesService: { findAllSystemRoles: jest.Mock };

  beforeEach(async () => {
    rolesService = { findAllSystemRoles: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RolesController],
      providers: [{ provide: RolesService, useValue: rolesService }],
    }).compile();

    controller = module.get<RolesController>(RolesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('findAllSystemRoles delega en rolesService.findAllSystemRoles', () => {
    const response = {
      success: true,
      message: 'ok',
      data: [{ id: 'role-1', name: 'ADMIN', isSystemRole: true }],
    };
    rolesService.findAllSystemRoles.mockReturnValue(response);

    const result = controller.findAllSystemRoles();

    expect(rolesService.findAllSystemRoles).toHaveBeenCalledWith();
    expect(result).toBe(response);
  });
});
