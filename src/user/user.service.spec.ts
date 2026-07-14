import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { UserEntity } from './entities/user.entity';
import { PersonalInformationEntity } from './entities/personal-information.entity';
import { SignatureService } from 'src/signature/signature.service';
import { RedisService } from 'src/shared/redis/redis.service';
import { AccountService } from 'src/account/account.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UserRoles } from './enums/user-roles';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
}

function createMockQueryRunner() {
  return {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      create: jest.fn((_entity, data) => data),
      save: jest.fn(async (data) => ({ id: 'generated-id', ...data })),
    },
  };
}

describe('UserService', () => {
  let service: UserService;
  let userRepository: ReturnType<typeof createMockRepository>;
  let personalInformationRepository: ReturnType<typeof createMockRepository>;
  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: ReturnType<typeof createMockQueryRunner>;
  let redisService: { set: jest.Mock; get: jest.Mock };
  let accountService: {
    createDefaultPersonalAccount: jest.Mock;
    appendAccountToCatalog: jest.Mock;
  };

  beforeEach(async () => {
    userRepository = createMockRepository();
    personalInformationRepository = createMockRepository();
    queryRunner = createMockQueryRunner();
    dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
    };
    redisService = { set: jest.fn(), get: jest.fn() };
    accountService = {
      createDefaultPersonalAccount: jest
        .fn()
        .mockResolvedValue({ id: 'personal-account-1' }),
      appendAccountToCatalog: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        {
          provide: getRepositoryToken(PersonalInformationEntity),
          useValue: personalInformationRepository,
        },
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: SignatureService,
          useValue: { findOne: jest.fn(), getFile: jest.fn() },
        },
        { provide: RedisService, useValue: redisService },
        { provide: AccountService, useValue: accountService },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const dto: CreateUserDto = {
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'Juan.Perez@Empresa.com',
      position: 'Gerente',
      roles: [UserRoles.SIGNER],
      nationalId: 'PELJ850101HDFRNN08',
      rfc: 'PELJ850101ABC',
    };

    it('crea el usuario dentro de una transacción cuando todo es válido', async () => {
      userRepository.findOne.mockResolvedValue(null);
      personalInformationRepository.findOne.mockResolvedValue(null);

      const result = await service.create(dto);

      expect(dataSource.createQueryRunner).toHaveBeenCalled();
      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data.email).toBe('juan.perez@empresa.com');
      expect(result.data.nationalId).toBe('PELJ850101HDFRNN08');
      // removeSensitiveData no debe filtrar la contraseña
      expect((result.data as any).password).toBeUndefined();
    });

    it('rechaza con ConflictException si el correo ya está registrado', async () => {
      userRepository.findOne.mockResolvedValue({ id: 'existing-user' });

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('rechaza con ConflictException si el CURP ya está en uso por otro usuario activo', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(null) // email check
        .mockResolvedValueOnce({ id: 'other-user' }); // assertCurpNotTaken

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('rechaza con ConflictException si el RFC ya está en uso', async () => {
      userRepository.findOne.mockResolvedValue(null);
      personalInformationRepository.findOne.mockResolvedValue({
        id: 'other-personal-info',
      });

      await expect(service.create(dto)).rejects.toThrow(ConflictException);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('hace rollback y no deja fila huérfana si falla el save del usuario', async () => {
      userRepository.findOne.mockResolvedValue(null);
      personalInformationRepository.findOne.mockResolvedValue(null);

      queryRunner.manager.save = jest
        .fn()
        .mockResolvedValueOnce({ id: 'personal-info-id' }) // guarda PersonalInformation OK
        .mockRejectedValueOnce(new Error('duplicate key value')); // falla al guardar User

      await expect(service.create(dto)).rejects.toThrow('duplicate key value');
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('createFromSignup', () => {
    const dto = {
      firstName: 'Ana',
      lastName: 'Gómez',
      email: 'ana@empresa.com',
      position: 'Analista',
      nationalId: 'GOMA900101MDFRNN01',
      rfc: 'GOMA900101XYZ',
    };

    it('registra el usuario correctamente, cachea el perfil en Redis por CURP y crea la cuenta personal por defecto', async () => {
      userRepository.findOne.mockResolvedValue(null);
      personalInformationRepository.findOne.mockResolvedValue(null);

      const result = await service.createFromSignup(dto, 'hashed-password');

      expect(result.success).toBe(true);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(redisService.set).toHaveBeenCalledWith(
        dto.nationalId.toUpperCase(),
        expect.any(String),
      );
      expect(accountService.createDefaultPersonalAccount).toHaveBeenCalledWith(
        queryRunner.manager,
        expect.any(String),
        `${dto.firstName} ${dto.lastName}`,
      );
      expect(accountService.appendAccountToCatalog).toHaveBeenCalledWith(
        expect.any(String),
        { id: 'personal-account-1' },
      );
    });

    it('rechaza con ConflictException si el email ya existe', async () => {
      userRepository.findOne.mockResolvedValue({ id: 'existing' });

      await expect(
        service.createFromSignup(dto, 'hashed-password'),
      ).rejects.toThrow(ConflictException);
    });

    it('rechaza con ConflictException si el CURP ya existe', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'other-user' });

      await expect(
        service.createFromSignup(dto, 'hashed-password'),
      ).rejects.toThrow(ConflictException);
    });

    it('rechaza con ConflictException si el RFC ya existe', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(null) // email
        .mockResolvedValueOnce(null); // curp
      personalInformationRepository.findOne.mockResolvedValue({
        id: 'other-info',
      });

      await expect(
        service.createFromSignup(dto, 'hashed-password'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('updatePersonalInformation', () => {
    it('actualiza phoneNumber y secondaryEmail', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        personalInformationId: 'pi-1',
      });
      personalInformationRepository.findOne.mockResolvedValue({
        id: 'pi-1',
        phoneNumber: '5512345678',
        secondaryEmail: 'secundario@correo.com',
      });

      const result = await service.updatePersonalInformation('user-1', {
        phoneNumber: '5512345678',
        secondaryEmail: 'secundario@correo.com',
      });

      expect(personalInformationRepository.update).toHaveBeenCalledWith(
        'pi-1',
        { phoneNumber: '5512345678', secondaryEmail: 'secundario@correo.com' },
      );
      expect(result.data.phoneNumber).toBe('5512345678');
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updatePersonalInformation('missing-user', {
          phoneNumber: '5512345678',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('fija isConfigured=true y refresca el cache de Redis por CURP', async () => {
      userRepository.findOne
        .mockResolvedValueOnce({ id: 'user-1', nationalId: 'CURP1' }) // existencia
        .mockResolvedValueOnce({
          id: 'user-1',
          nationalId: 'CURP1',
          isConfigured: true,
          signatureId: 'sig-1',
          personalInformation: {
            rfc: 'RFC1',
            phoneNumber: '123',
            secondaryEmail: 'a@a.com',
          },
        }); // refetch

      const result = await service.updateStatus('user-1', {
        isConfigured: true,
      });

      expect(userRepository.update).toHaveBeenCalledWith('user-1', {
        isConfigured: true,
      });
      expect(redisService.set).toHaveBeenCalledWith(
        'CURP1',
        expect.any(String),
      );
      expect(result.data.isConfigured).toBe(true);
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateStatus('missing-user', { isConfigured: true }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
