import { Test, TestingModule } from '@nestjs/testing';
import { AccountMemberController } from './account-member.controller';
import { AccountMemberService } from './account-member.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('AccountMemberController', () => {
  let controller: AccountMemberController;
  let accountMemberService: {
    create: jest.Mock;
    findByOrganization: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const user: JwtPayload = {
    sub: 'owner-1',
    email: 'owner@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    accountMemberService = {
      create: jest.fn(),
      findByOrganization: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountMemberController],
      providers: [
        { provide: AccountMemberService, useValue: accountMemberService },
      ],
    }).compile();

    controller = module.get<AccountMemberController>(AccountMemberController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('create delega en accountMemberService.create con el userId del JWT', () => {
    const dto = { organizationId: 'org-1', userId: 'user-2', roleId: 'role-1' };
    controller.create(user, dto as any);

    expect(accountMemberService.create).toHaveBeenCalledWith('owner-1', dto);
  });

  it('findByOrganization delega en accountMemberService.findByOrganization con el userId del JWT', () => {
    controller.findByOrganization(user, 'org-1');

    expect(accountMemberService.findByOrganization).toHaveBeenCalledWith(
      'owner-1',
      'org-1',
    );
  });

  it('findOne delega en accountMemberService.findOne con el userId del JWT', () => {
    controller.findOne(user, 'member-1');

    expect(accountMemberService.findOne).toHaveBeenCalledWith(
      'owner-1',
      'member-1',
    );
  });

  it('update delega en accountMemberService.update con el userId del JWT', () => {
    const dto = { isActive: false };
    controller.update(user, 'member-1', dto);

    expect(accountMemberService.update).toHaveBeenCalledWith(
      'owner-1',
      'member-1',
      dto,
    );
  });

  it('remove delega en accountMemberService.remove con el userId del JWT', () => {
    controller.remove(user, 'member-1');

    expect(accountMemberService.remove).toHaveBeenCalledWith(
      'owner-1',
      'member-1',
    );
  });
});
