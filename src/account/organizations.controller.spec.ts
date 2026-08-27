import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationsController } from './organizations.controller';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { CreateOrganizationUseCase } from './applications/create-organization.use-case';
import { InviteOrganizationMemberUseCase } from './applications/invite-organization-member.use-case';
import { GetOrganizationMemberListUseCase } from './applications/get-organization-member-list.use-case';
import { UpdateAccountMemberUseCase } from './applications/update-account-member.use-case';
import { RevokeAccountAccessUseCase } from './applications/revoke-account-access.use-case';
import { GetMemberPermissionsUseCase } from 'src/organization-permissions/applications/get-member-permissions.use-case';
import { AssignMemberPermissionsUseCase } from 'src/organization-permissions/applications/assign-member-permissions.use-case';

describe('OrganizationsController', () => {
  let controller: OrganizationsController;
  let createOrganization: { execute: jest.Mock };
  let inviteOrganizationMember: { execute: jest.Mock };
  let getOrganizationMemberList: { execute: jest.Mock };
  let updateAccountMember: { execute: jest.Mock };
  let revokeAccountAccess: { execute: jest.Mock };
  let getMemberPermissions: { execute: jest.Mock };
  let assignMemberPermissions: { execute: jest.Mock };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    createOrganization = { execute: jest.fn() };
    inviteOrganizationMember = { execute: jest.fn() };
    getOrganizationMemberList = { execute: jest.fn() };
    updateAccountMember = { execute: jest.fn() };
    revokeAccountAccess = { execute: jest.fn() };
    getMemberPermissions = { execute: jest.fn() };
    assignMemberPermissions = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        { provide: CreateOrganizationUseCase, useValue: createOrganization },
        {
          provide: InviteOrganizationMemberUseCase,
          useValue: inviteOrganizationMember,
        },
        {
          provide: GetOrganizationMemberListUseCase,
          useValue: getOrganizationMemberList,
        },
        { provide: UpdateAccountMemberUseCase, useValue: updateAccountMember },
        { provide: RevokeAccountAccessUseCase, useValue: revokeAccountAccess },
        {
          provide: GetMemberPermissionsUseCase,
          useValue: getMemberPermissions,
        },
        {
          provide: AssignMemberPermissionsUseCase,
          useValue: assignMemberPermissions,
        },
      ],
    }).compile();

    controller = module.get<OrganizationsController>(OrganizationsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('create delega en CreateOrganizationUseCase con el userId del JWT', () => {
    const dto = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };
    controller.create(user, dto);

    expect(createOrganization.execute).toHaveBeenCalledWith('user-1', dto);
  });

  /**
   * Toda la orquestación de la invitación —validar quién invita, persistirla y publicar el
   * evento— vive ahora en el caso de uso: el controller sólo pasa el usuario del JWT, el
   * `X-Account-Id` y el body.
   */
  it('invite delega en InviteOrganizationMemberUseCase con el userId del JWT y el accountId activo', () => {
    const dto = { email: 'nuevo@empresa.com', roleId: 'role-1' };
    controller.invite(user, 'account-1', dto);

    expect(inviteOrganizationMember.execute).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      dto,
    );
  });

  it('findMembers delega en GetOrganizationMemberListUseCase con el userId del JWT y el organizationId de la ruta', () => {
    controller.findMembers(user, 'org-1');

    expect(getOrganizationMemberList.execute).toHaveBeenCalledWith(
      'user-1',
      'org-1',
    );
  });

  it('updateMemberRole delega en UpdateAccountMemberUseCase con solo el roleId del body', () => {
    controller.updateMemberRole(user, 'account-1', { roleId: 'role-2' });

    expect(updateAccountMember.execute).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      { roleId: 'role-2' },
    );
  });

  it('removeMember delega en RevokeAccountAccessUseCase con el userId del JWT y el accountId de la ruta', () => {
    controller.removeMember(user, 'account-1');

    expect(revokeAccountAccess.execute).toHaveBeenCalledWith(
      'user-1',
      'account-1',
    );
  });

  it('findMemberPermissions delega en GetMemberPermissionsUseCase con el userId del JWT y el accountId de la ruta', () => {
    controller.findMemberPermissions(user, 'account-1');

    expect(getMemberPermissions.execute).toHaveBeenCalledWith(
      'user-1',
      'account-1',
    );
  });

  it('assignMemberPermissions delega en AssignMemberPermissionsUseCase con los permissionIds del body', () => {
    const dto = { permissionIds: ['perm-1', 'perm-2'] };
    controller.assignMemberPermissions(user, 'account-1', dto);

    expect(assignMemberPermissions.execute).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      ['perm-1', 'perm-2'],
    );
  });
});
