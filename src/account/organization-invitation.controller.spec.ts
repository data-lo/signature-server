import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationInvitationsController } from './organization-invitation.controller';
import { GetOrganizationInvitationPreviewUseCase } from './applications/get-organization-invitation-preview.use-case';
import { AcceptOrganizationInvitationUseCase } from './applications/accept-organization-invitation.use-case';

describe('OrganizationInvitationsController', () => {
  let controller: OrganizationInvitationsController;
  let getInvitationPreview: { execute: jest.Mock };
  let acceptInvitation: { execute: jest.Mock };

  beforeEach(async () => {
    getInvitationPreview = { execute: jest.fn() };
    acceptInvitation = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationInvitationsController],
      providers: [
        {
          provide: GetOrganizationInvitationPreviewUseCase,
          useValue: getInvitationPreview,
        },
        {
          provide: AcceptOrganizationInvitationUseCase,
          useValue: acceptInvitation,
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

  it('getPreview delega en GetOrganizationInvitationPreviewUseCase con el token de la ruta', () => {
    controller.getPreview('token-1');

    expect(getInvitationPreview.execute).toHaveBeenCalledWith('token-1');
  });

  it('accept delega en AcceptOrganizationInvitationUseCase con el token de la ruta y el rfc del body', () => {
    controller.accept('token-1', { rfc: 'RFC123456789' });

    expect(acceptInvitation.execute).toHaveBeenCalledWith(
      'token-1',
      'RFC123456789',
    );
  });
});
