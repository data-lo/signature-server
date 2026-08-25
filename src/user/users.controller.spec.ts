import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UserService } from './user.service';
import { UploadSignatureImageUseCase } from 'src/signature/applications/upload-signature-image.use-case';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('UsersController', () => {
  let controller: UsersController;
  let userService: {
    getMeFromCache: jest.Mock;
    updatePersonalInformation: jest.Mock;
    updateStatus: jest.Mock;
    refreshCurpCacheForUser: jest.Mock;
    checkRfcAvailability: jest.Mock;
  };
  let uploadSignatureImage: { execute: jest.Mock };

  const user: JwtPayload = {
    sub: 'user-1',
    email: 'juan@empresa.com',
    roles: ['signer'],
    nationalId: 'PELJ850101HDFRNN08',
    jti: 'jti-1',
  };

  beforeEach(async () => {
    userService = {
      getMeFromCache: jest.fn(),
      updatePersonalInformation: jest.fn(),
      updateStatus: jest.fn(),
      refreshCurpCacheForUser: jest.fn(),
      checkRfcAvailability: jest.fn(),
    };
    uploadSignatureImage = { execute: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UserService, useValue: userService },
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

  it('getMe delega en userService.getMeFromCache con el CURP del JWT', () => {
    controller.getMe(user);

    expect(userService.getMeFromCache).toHaveBeenCalledWith(
      'PELJ850101HDFRNN08',
    );
  });

  it('updatePersonalInformation delega en userService.updatePersonalInformation con el userId del JWT', () => {
    const dto = { phoneNumber: '5512345678' };
    controller.updatePersonalInformation(user, dto);

    expect(userService.updatePersonalInformation).toHaveBeenCalledWith(
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
    // El caso de uso ya invalida el snapshot de perfil al mover el estado de la credencial: el
    // controller no vuelve a tocar el cache.
    expect(userService.refreshCurpCacheForUser).not.toHaveBeenCalled();
    expect(result).toBe(uploadResult);
  });

  it('updateStatus delega en userService.updateStatus con el userId del JWT', () => {
    const dto = { isConfigured: true };
    controller.updateStatus(user, dto);

    expect(userService.updateStatus).toHaveBeenCalledWith('user-1', dto);
  });

  it('checkRfc delega en userService.checkRfcAvailability con el rfc del query param', () => {
    controller.checkRfc('PELJ850101ABC');

    expect(userService.checkRfcAvailability).toHaveBeenCalledWith(
      'PELJ850101ABC',
    );
  });
});
