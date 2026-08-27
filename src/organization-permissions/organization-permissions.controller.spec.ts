import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationPermissionsController } from './organization-permissions.controller';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { GetOrganizationPermissionsUseCase } from './applications/get-organization-permissions.use-case';
import { CreateOrganizationPermissionUseCase } from './applications/create-organization-permission.use-case';
import { UpdateOrganizationPermissionUseCase } from './applications/update-organization-permission.use-case';
import { DeleteOrganizationPermissionUseCase } from './applications/delete-organization-permission.use-case';

describe('OrganizationPermissionsController', () => {
  let controller: OrganizationPermissionsController;
  let getOrganizationPermissions: { execute: jest.Mock };
  let createOrganizationPermission: { execute: jest.Mock };
  let updateOrganizationPermission: { execute: jest.Mock };
  let deleteOrganizationPermission: { execute: jest.Mock };

  const user: JwtPayload = {
    sub: 'owner-1',
    email: 'owner@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    getOrganizationPermissions = { execute: jest.fn() };
    createOrganizationPermission = { execute: jest.fn() };
    updateOrganizationPermission = { execute: jest.fn() };
    deleteOrganizationPermission = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationPermissionsController],
      providers: [
        {
          provide: GetOrganizationPermissionsUseCase,
          useValue: getOrganizationPermissions,
        },
        {
          provide: CreateOrganizationPermissionUseCase,
          useValue: createOrganizationPermission,
        },
        {
          provide: UpdateOrganizationPermissionUseCase,
          useValue: updateOrganizationPermission,
        },
        {
          provide: DeleteOrganizationPermissionUseCase,
          useValue: deleteOrganizationPermission,
        },
      ],
    }).compile();

    controller = module.get<OrganizationPermissionsController>(
      OrganizationPermissionsController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  /**
   * El `callerId` sale siempre de `@CurrentUser()` y nunca del body ni de la ruta: es lo único
   * que impide que quien llama diga ser el administrador de la organización.
   */
  it('findAll pasa el userId del JWT y el organizationId de la ruta', () => {
    controller.findAll(user, 'org-1');

    expect(getOrganizationPermissions.execute).toHaveBeenCalledWith(
      'owner-1',
      'org-1',
    );
  });

  it('create pasa el userId del JWT, el organizationId y el dto', () => {
    const dto = { name: 'Aprobar documentos' };
    controller.create(user, 'org-1', dto);

    expect(createOrganizationPermission.execute).toHaveBeenCalledWith(
      'owner-1',
      'org-1',
      dto,
    );
  });

  it('update pasa el userId del JWT, ambos parametros de ruta y el dto', () => {
    const dto = { isActive: false };
    controller.update(user, 'org-1', 'perm-1', dto);

    expect(updateOrganizationPermission.execute).toHaveBeenCalledWith(
      'owner-1',
      'org-1',
      'perm-1',
      dto,
    );
  });

  it('remove pasa el userId del JWT y ambos parametros de ruta', () => {
    controller.remove(user, 'org-1', 'perm-1');

    expect(deleteOrganizationPermission.execute).toHaveBeenCalledWith(
      'owner-1',
      'org-1',
      'perm-1',
    );
  });
});
