import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UserService } from './user.service';
import { SignatureService } from 'src/signature/signature.service';
import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

describe('UsersController', () => {
  let controller: UsersController;
  let userService: {
    getMeFromCache: jest.Mock;
    updatePersonalInformation: jest.Mock;
    updateStatus: jest.Mock;
    refreshCurpCacheForUser: jest.Mock;
  };
  let signatureService: { create: jest.Mock };

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
    };
    signatureService = { create: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UserService, useValue: userService },
        { provide: SignatureService, useValue: signatureService },
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

  it('updateSignature delega en signatureService.create y refresca el cache de Redis por CURP', async () => {
    const dto = { signatureImage: {} } as any;
    const files = { signatureImage: [{ originalname: 'firma.png' }] } as any;
    const createResult = { success: true, message: 'ok', data: { id: 'sig-1' } };
    signatureService.create.mockResolvedValue(createResult);

    const result = await controller.updateSignature(user, dto, files);

    expect(signatureService.create).toHaveBeenCalledWith(
      'user-1',
      dto,
      files,
    );
    expect(userService.refreshCurpCacheForUser).toHaveBeenCalledWith(
      'user-1',
    );
    expect(result).toBe(createResult);
  });

  it('updateStatus delega en userService.updateStatus con el userId del JWT', () => {
    const dto = { isConfigured: true };
    controller.updateStatus(user, dto);

    expect(userService.updateStatus).toHaveBeenCalledWith('user-1', dto);
  });
});
