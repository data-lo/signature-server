import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationInvitationsController } from './organization-invitation.controller';
import { OrganizationInvitationService } from './organization-invitation.service';

describe('OrganizationInvitationsController', () => {
  let controller: OrganizationInvitationsController;
  let organizationInvitationService: {
    getPreview: jest.Mock;
    acceptByRfc: jest.Mock;
  };

  beforeEach(async () => {
    organizationInvitationService = {
      getPreview: jest.fn(),
      acceptByRfc: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationInvitationsController],
      providers: [
        {
          provide: OrganizationInvitationService,
          useValue: organizationInvitationService,
        },
      ],
    }).compile();

    controller = module.get<OrganizationInvitationsController>(
      OrganizationInvitationsController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('getPreview delega en organizationInvitationService.getPreview con el token de la ruta', () => {
    controller.getPreview('token-1');

    expect(organizationInvitationService.getPreview).toHaveBeenCalledWith(
      'token-1',
    );
  });

  it('accept delega en organizationInvitationService.acceptByRfc con el token de la ruta y el rfc del body', () => {
    controller.accept('token-1', { rfc: 'RFC123456789' });

    expect(organizationInvitationService.acceptByRfc).toHaveBeenCalledWith(
      'token-1',
      'RFC123456789',
    );
  });
});
