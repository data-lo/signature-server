import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationPermissionsController } from './organization-permissions.controller';
import { OrganizationPermissionsService } from './organization-permissions.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('OrganizationPermissionsController', () => {
  let controller: OrganizationPermissionsController;
  let service: {
    findAllForOrganization: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    service = {
      findAllForOrganization: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationPermissionsController],
      providers: [
        { provide: OrganizationPermissionsService, useValue: service },
      ],
    }).compile();

    controller = module.get<OrganizationPermissionsController>(
      OrganizationPermissionsController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('findAll delega en service.findAllForOrganization con el userId del JWT y el organizationId de la ruta', () => {
    controller.findAll(user, 'org-1');

    expect(service.findAllForOrganization).toHaveBeenCalledWith(
      'user-1',
      'org-1',
    );
  });

  it('create delega en service.create con el userId del JWT, el organizationId de la ruta y el body', () => {
    const dto = { name: 'Aprobar documentos' };
    controller.create(user, 'org-1', dto);

    expect(service.create).toHaveBeenCalledWith('user-1', 'org-1', dto);
  });

  it('update delega en service.update con el userId del JWT, organizationId y permissionId de la ruta, y el body', () => {
    const dto = { isActive: false };
    controller.update(user, 'org-1', 'perm-1', dto);

    expect(service.update).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'perm-1',
      dto,
    );
  });

  it('remove delega en service.remove con el userId del JWT, organizationId y permissionId de la ruta', () => {
    controller.remove(user, 'org-1', 'perm-1');

    expect(service.remove).toHaveBeenCalledWith('user-1', 'org-1', 'perm-1');
  });
});
