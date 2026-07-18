import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationsController } from './organizations.controller';
import { AccountService } from './account.service';
import { AccountMemberService } from './account-member.service';
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

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    accountService = { createOrganization: jest.fn(), inviteMember: jest.fn() };
    accountMemberService = {
      findMembersForOrganizationDetailed: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        { provide: AccountService, useValue: accountService },
        { provide: AccountMemberService, useValue: accountMemberService },
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

  it('invite delega en accountService.inviteMember con el userId del JWT y el accountId del header', () => {
    const dto = { email: 'nuevo@empresa.com', roleId: 'role-1' };
    controller.invite(user, 'org-1', dto);

    expect(accountService.inviteMember).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      dto,
    );
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
});
