import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationsController } from './organizations.controller';
import { AccountService } from './account.service';
import { AccountMemberService } from './account-member.service';
import { OrganizationInvitationService } from './organization-invitation.service';
import { OrganizationPermissionsService } from 'src/organization-permissions/organization-permissions.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('OrganizationsController', () => {
  let controller: OrganizationsController;
  let accountService: {
    createOrganization: jest.Mock;
    inviteMember: jest.Mock;
  };
  let accountMemberService: {
    findMembersForOrganizationDetailed: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };
  let organizationInvitationService: { create: jest.Mock };
  let organizationPermissionsService: {
    findMemberPermissions: jest.Mock;
    assignToMember: jest.Mock;
  };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    accountService = {
      createOrganization: jest.fn(),
      inviteMember: jest.fn().mockResolvedValue({
        success: true,
        message: 'Invitación validada correctamente',
        data: { organizationId: 'org-1' },
      }),
    };
    accountMemberService = {
      findMembersForOrganizationDetailed: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    organizationInvitationService = { create: jest.fn() };
    organizationPermissionsService = {
      findMemberPermissions: jest.fn(),
      assignToMember: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        { provide: AccountService, useValue: accountService },
        { provide: AccountMemberService, useValue: accountMemberService },
        {
          provide: OrganizationInvitationService,
          useValue: organizationInvitationService,
        },
        {
          provide: OrganizationPermissionsService,
          useValue: organizationPermissionsService,
        },
      ],
    }).compile();

    controller = module.get<OrganizationsController>(OrganizationsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('create delega en accountService.createOrganization con el userId del JWT', () => {
    const dto = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };
    controller.create(user, dto);

    expect(accountService.createOrganization).toHaveBeenCalledWith(
      'user-1',
      dto,
    );
  });

  it('invite valida con accountService.inviteMember y persiste+publica la invitación con organizationInvitationService.create', async () => {
    const dto = { email: 'nuevo@empresa.com', roleId: 'role-1' };
    const result = await controller.invite(user, 'account-1', dto);

    expect(accountService.inviteMember).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      dto,
    );
    expect(organizationInvitationService.create).toHaveBeenCalledWith({
      organizationId: 'org-1',
      roleId: 'role-1',
      invitedBy: 'user-1',
      email: 'nuevo@empresa.com',
    });
    expect(result).toEqual({
      success: true,
      message: 'Invitación enviada correctamente',
      data: null,
    });
  });

  it('findMembers delega en accountMemberService.findMembersForOrganizationDetailed con el userId del JWT y el organizationId de la ruta', () => {
    controller.findMembers(user, 'org-1');

    expect(
      accountMemberService.findMembersForOrganizationDetailed,
    ).toHaveBeenCalledWith('user-1', 'org-1');
  });

  it('updateMemberRole delega en accountMemberService.update con el userId del JWT, el accountId de la ruta y solo el roleId del body', () => {
    controller.updateMemberRole(user, 'account-1', { roleId: 'role-2' });

    expect(accountMemberService.update).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      { roleId: 'role-2' },
    );
  });

  it('removeMember delega en accountMemberService.remove con el userId del JWT y el accountId de la ruta', () => {
    controller.removeMember(user, 'account-1');

    expect(accountMemberService.remove).toHaveBeenCalledWith(
      'user-1',
      'account-1',
    );
  });

  it('findMemberPermissions delega en organizationPermissionsService.findMemberPermissions con el userId del JWT y el accountId de la ruta', () => {
    controller.findMemberPermissions(user, 'account-1');

    expect(
      organizationPermissionsService.findMemberPermissions,
    ).toHaveBeenCalledWith('user-1', 'account-1');
  });

  it('assignMemberPermissions delega en organizationPermissionsService.assignToMember con el userId del JWT, el accountId de la ruta y los permissionIds del body', () => {
    const dto = { permissionIds: ['perm-1', 'perm-2'] };
    controller.assignMemberPermissions(user, 'account-1', dto);

    expect(organizationPermissionsService.assignToMember).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      ['perm-1', 'perm-2'],
    );
  });
});
