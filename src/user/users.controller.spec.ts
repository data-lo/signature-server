import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UploadSignatureImageUseCase } from 'src/signature/applications/upload-signature-image.use-case';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';
import { CheckRfcAvailabilityUseCase } from './applications/check-rfc-availability.use-case';
import { GetMyProfileUseCase } from './applications/get-my-profile.use-case';
import { UpdateMyPersonalInformationUseCase } from './applications/update-my-personal-information.use-case';
import { CompleteMyOnboardingUseCase } from './applications/complete-my-onboarding.use-case';

describe('UsersController', () => {
  let controller: UsersController;
  let checkRfcAvailability: { execute: jest.Mock };
  let getMyProfile: { execute: jest.Mock };
  let updateMyPersonalInformation: { execute: jest.Mock };
  let completeMyOnboarding: { execute: jest.Mock };
  let uploadSignatureImage: { execute: jest.Mock };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    checkRfcAvailability = { execute: jest.fn() };
    getMyProfile = { execute: jest.fn() };
    updateMyPersonalInformation = { execute: jest.fn() };
    completeMyOnboarding = { execute: jest.fn() };
    uploadSignatureImage = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: CheckRfcAvailabilityUseCase,
          useValue: checkRfcAvailability,
        },
        { provide: GetMyProfileUseCase, useValue: getMyProfile },
        {
          provide: UpdateMyPersonalInformationUseCase,
          useValue: updateMyPersonalInformation,
        },
        {
          provide: CompleteMyOnboardingUseCase,
          useValue: completeMyOnboarding,
        },
        {
          provide: UploadSignatureImageUseCase,
          useValue: uploadSignatureImage,
        },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('getMe delega en GetMyProfileUseCase con el CURP del JWT', () => {
    controller.getMe(user);

    expect(getMyProfile.execute).toHaveBeenCalledWith('PELJ850101HDFRNN08');
  });

  it('updatePersonalInformation delega en el caso de uso con el userId del JWT', () => {
    const dto = { phoneNumber: '5512345678' };
    controller.updatePersonalInformation(user, dto);

    expect(updateMyPersonalInformation.execute).toHaveBeenCalledWith(
      'user-1',
      dto,
    );
  });

  it('updateSignature delega en el caso de uso con el userId del JWT', async () => {
    const dto = { signatureImage: {} } as any;
    const files = { signatureImage: [{ originalname: 'firma.png' }] } as any;
    const uploadResult = {
      success: true,
      message: 'ok',
      data: { id: 'sig-1' },
    };
    uploadSignatureImage.execute.mockResolvedValue(uploadResult);

    const result = await controller.updateSignature(user, dto, files);

    expect(uploadSignatureImage.execute).toHaveBeenCalledWith(
      'user-1',
      dto,
      files,
    );
    expect(result).toBe(uploadResult);
  });

  it('updateStatus delega en CompleteMyOnboardingUseCase con el userId del JWT', () => {
    const dto = { isConfigured: true };
    controller.updateStatus(user, dto);

    expect(completeMyOnboarding.execute).toHaveBeenCalledWith('user-1', dto);
  });

  it('checkRfc delega en CheckRfcAvailabilityUseCase con el rfc del query param', () => {
    controller.checkRfc('PELJ850101ABC');

    expect(checkRfcAvailability.execute).toHaveBeenCalledWith('PELJ850101ABC');
  });
});
