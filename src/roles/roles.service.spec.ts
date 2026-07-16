import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RolesService } from './roles.service';
import { RoleEntity } from './entities/role.entity';

function createMockRepository() {
  return {
    find: jest.fn(),
  };
}

describe('RolesService', () => {
  let service: RolesService;
  let roleRepository: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    roleRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: getRepositoryToken(RoleEntity), useValue: roleRepository },
      ],
    }).compile();

    service = module.get<RolesService>(RolesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('findAllSystemRoles consulta solo roles con isSystemRole=true y mapea id/name/isSystemRole', async () => {
    roleRepository.find.mockResolvedValue([
      { id: 'role-1', name: 'ADMIN', isSystemRole: true, organizationId: null },
      {
        id: 'role-2',
        name: 'MEMBER',
        isSystemRole: true,
        organizationId: null,
      },
    ]);

    const result = await service.findAllSystemRoles();

    expect(roleRepository.find).toHaveBeenCalledWith({
      where: { isSystemRole: true },
      order: { name: 'ASC' },
    });
    expect(result).toEqual({
      success: true,
      message: 'Roles del sistema obtenidos correctamente',
      data: [
        { id: 'role-1', name: 'ADMIN', isSystemRole: true },
        { id: 'role-2', name: 'MEMBER', isSystemRole: true },
      ],
    });
  });

  it('findAllSystemRoles retorna data vacía si no hay roles del sistema', async () => {
    roleRepository.find.mockResolvedValue([]);

    const result = await service.findAllSystemRoles();

    expect(result.data).toEqual([]);
  });
});
