import { Test, TestingModule } from '@nestjs/testing';
import { AccountMemberController } from './account-member.controller';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { GrantAccountAccessUseCase } from './applications/grant-account-access.use-case';
import { GetOrganizationMembersUseCase } from './applications/get-organization-members.use-case';
import { GetAccountMemberUseCase } from './applications/get-account-member.use-case';
import { UpdateAccountMemberUseCase } from './applications/update-account-member.use-case';
import { RevokeAccountAccessUseCase } from './applications/revoke-account-access.use-case';

describe('AccountMemberController', () => {
  let controller: AccountMemberController;
  let grantAccountAccess: { execute: jest.Mock };
  let getOrganizationMembers: { execute: jest.Mock };
  let getAccountMember: { execute: jest.Mock };
  let updateAccountMember: { execute: jest.Mock };
  let revokeAccountAccess: { execute: jest.Mock };

  const user: JwtPayload = {
    sub: 'owner-1',
    email: 'owner@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    grantAccountAccess = { execute: jest.fn() };
    getOrganizationMembers = { execute: jest.fn() };
    getAccountMember = { execute: jest.fn() };
    updateAccountMember = { execute: jest.fn() };
    revokeAccountAccess = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountMemberController],
      providers: [
        { provide: GrantAccountAccessUseCase, useValue: grantAccountAccess },
        {
          provide: GetOrganizationMembersUseCase,
          useValue: getOrganizationMembers,
        },
        { provide: GetAccountMemberUseCase, useValue: getAccountMember },
        { provide: UpdateAccountMemberUseCase, useValue: updateAccountMember },
        { provide: RevokeAccountAccessUseCase, useValue: revokeAccountAccess },
      ],
    }).compile();

    controller = module.get<AccountMemberController>(AccountMemberController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  /**
   * El `callerId` sale siempre de `@CurrentUser()`: si viniera del body, cualquiera podría
   * decir ser el administrador de la organización.
   */
  it('create pasa el userId del JWT y el dto', () => {
    const dto = { organizationId: 'org-1', userId: 'user-2', roleId: 'role-1' };
    controller.create(user, dto as never);

    expect(grantAccountAccess.execute).toHaveBeenCalledWith('owner-1', dto);
  });

  it('findByOrganization pasa el userId del JWT y el organizationId del query', () => {
    controller.findByOrganization(user, 'org-1');

    expect(getOrganizationMembers.execute).toHaveBeenCalledWith(
      'owner-1',
      'org-1',
    );
  });

  it('findOne pasa el userId del JWT y el id de la ruta', () => {
    controller.findOne(user, 'member-1');

    expect(getAccountMember.execute).toHaveBeenCalledWith(
      'owner-1',
      'member-1',
    );
  });

  it('update pasa el userId del JWT, el id de la ruta y el dto', () => {
    const dto = { roleId: 'role-2' };
    controller.update(user, 'member-1', dto);

    expect(updateAccountMember.execute).toHaveBeenCalledWith(
      'owner-1',
      'member-1',
      dto,
    );
  });

  it('remove pasa el userId del JWT y el id de la ruta', () => {
    controller.remove(user, 'member-1');

    expect(revokeAccountAccess.execute).toHaveBeenCalledWith(
      'owner-1',
      'member-1',
    );
  });
});
