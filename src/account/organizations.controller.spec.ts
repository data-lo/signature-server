import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationsController } from './organizations.controller';
import { AccountService } from './account.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('OrganizationsController', () => {
  let controller: OrganizationsController;
  let accountService: { createOrganization: jest.Mock };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    accountService = { createOrganization: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [{ provide: AccountService, useValue: accountService }],
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
});
