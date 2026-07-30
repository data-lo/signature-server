import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { UserEntity } from './entities/user.entity';
import { PersonalInformationEntity } from './entities/personal-information.entity';
import { SignatureService } from 'src/signature/signature.service';
import { RedisService } from 'src/shared/redis/redis.service';
import { AccountService } from 'src/account/account.service';
import { EmailService } from 'src/shared/email/email.service';
import { EmailVerificationCodeService } from './email-verification-code.service';
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
  let emailService: { sendRegistrationOtpNotification: jest.Mock };
  let emailVerificationCodeService: { issue: jest.Mock };

  beforeEach(async () => {
    userRepository = createMockRepository();
    personalInformationRepository = createMockRepository();
    queryRunner = createMockQueryRunner();
    dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
    };
    redisService = { set: jest.fn(), get: jest.fn() };
    accountService = {
      createDefaultPersonalAccount: jest.fn().mockResolvedValue({
        account: { id: 'personal-account-1' },
      }),
      appendAccountToCatalog: jest.fn(),
    };
    emailService = {
      sendRegistrationOtpNotification: jest.fn().mockResolvedValue(undefined),
    };
    emailVerificationCodeService = {
      issue: jest.fn().mockResolvedValue({ code: '123456' }),
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
        { provide: EmailService, useValue: emailService },
        {
          provide: EmailVerificationCodeService,
          useValue: emailVerificationCodeService,
        },
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
      nationalId: 'GOMA900101MDFRNN01',
      rfc: 'GOMA900101XYZ',
    };

    it('CURP libre: registra la pre-cuenta (isEmailVerified:false), cachea el perfil en Redis, crea la cuenta personal y envía el primer OTP', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(null) // búsqueda por CURP
        .mockResolvedValueOnce(null); // búsqueda por email
      personalInformationRepository.findOne.mockResolvedValue(null); // RFC libre

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
        dto.email,
        'hashed-password',
      );
      expect(accountService.appendAccountToCatalog).toHaveBeenCalledWith(
        expect.any(String),
        { id: 'personal-account-1' },
      );
      expect(emailVerificationCodeService.issue).toHaveBeenCalledWith(
        expect.any(String),
      );
      expect(
        emailService.sendRegistrationOtpNotification,
      ).toHaveBeenCalledWith(dto.email, '123456');
      expect(result.data.isNewPreRegistration).toBe(true);
      expect(result.data.maskedEmail).toBe('a***a@empresa.com');
    });

    it('Caso A: CURP con pre-registro pendiente (isEmailVerified:false) reenvía el OTP al correo ya asociado, sin abrir transacción ni tocar los datos reenviados', async () => {
      const existingUser = {
        id: 'existing-user',
        email: 'original@empresa.com',
        isEmailVerified: false,
      };
      userRepository.findOne.mockResolvedValueOnce(existingUser);

      const result = await service.createFromSignup(dto, 'hashed-password');

      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
      expect(emailVerificationCodeService.issue).toHaveBeenCalledWith(
        'existing-user',
      );
      expect(
        emailService.sendRegistrationOtpNotification,
      ).toHaveBeenCalledWith('original@empresa.com', '123456');
      expect(result.data).toEqual({
        userId: 'existing-user',
        email: 'original@empresa.com',
        maskedEmail: 'o***l@empresa.com',
        isNewPreRegistration: false,
      });
    });

    it('Caso B: CURP con cuenta ya verificada rechaza con ConflictException sugiriendo iniciar sesión', async () => {
      userRepository.findOne.mockResolvedValueOnce({
        id: 'existing-user',
        email: 'ana@empresa.com',
        isEmailVerified: true,
      });

      await expect(
        service.createFromSignup(dto, 'hashed-password'),
      ).rejects.toThrow(ConflictException);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
      expect(emailVerificationCodeService.issue).not.toHaveBeenCalled();
    });

    it('rechaza con ConflictException si el email ya existe (CURP libre)', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(null) // curp
        .mockResolvedValueOnce({ id: 'existing' }); // email

      await expect(
        service.createFromSignup(dto, 'hashed-password'),
      ).rejects.toThrow(ConflictException);
    });

    it('rechaza con ConflictException si el RFC ya existe (CURP y email libres)', async () => {
      userRepository.findOne
        .mockResolvedValueOnce(null) // curp
        .mockResolvedValueOnce(null); // email
      personalInformationRepository.findOne.mockResolvedValue({
        id: 'other-info',
      });

      await expect(
        service.createFromSignup(dto, 'hashed-password'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('markEmailVerified', () => {
    it('marca isEmailVerified=true y refresca el cache de Redis por CURP', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        nationalId: 'CURP1',
        isEmailVerified: true,
        personalInformation: {
          rfc: 'RFC1',
          phoneNumber: null,
          secondaryEmail: null,
        },
      });

      const result = await service.markEmailVerified('user-1');

      expect(userRepository.update).toHaveBeenCalledWith('user-1', {
        isEmailVerified: true,
      });
      expect(redisService.set).toHaveBeenCalledWith(
        'CURP1',
        expect.any(String),
      );
      expect(result.isEmailVerified).toBe(true);
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.markEmailVerified('missing-user')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updatePersonalInformation', () => {
    it('actualiza phoneNumber y secondaryEmail, y refresca el cache de Redis por CURP', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        nationalId: 'CURP1',
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
      expect(redisService.set).toHaveBeenCalledWith(
        'CURP1',
        expect.any(String),
      );
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

  describe('checkRfcAvailability', () => {
    it('retorna exists:true si ya existe un registro de información personal con ese RFC', async () => {
      personalInformationRepository.findOne.mockResolvedValue({
        id: 'pi-1',
        rfc: 'PELJ850101ABC',
      });

      const result = await service.checkRfcAvailability('pelj850101abc');

      expect(personalInformationRepository.findOne).toHaveBeenCalledWith({
        where: { rfc: 'PELJ850101ABC' },
      });
      expect(result.data).toEqual({ exists: true });
    });

    it('retorna exists:false si no existe ningún registro con ese RFC', async () => {
      personalInformationRepository.findOne.mockResolvedValue(null);

      const result = await service.checkRfcAvailability('XAXX010101000');

      expect(result.data).toEqual({ exists: false });
    });
  });

  describe('refreshCurpCacheForUser', () => {
    it('reconstruye el snapshot desde PostgreSQL y lo recachea por CURP', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        nationalId: 'CURP1',
        isConfigured: false,
        signatureId: 'sig-1',
        personalInformation: {
          rfc: 'RFC1',
          phoneNumber: '5512345678',
          secondaryEmail: 'a@a.com',
        },
      });

      await service.refreshCurpCacheForUser('user-1');

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        relations: { personalInformation: true },
      });
      expect(redisService.set).toHaveBeenCalledWith(
        'CURP1',
        expect.any(String),
      );
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.refreshCurpCacheForUser('missing-user'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getMeFromCache', () => {
    it('retorna el snapshot cacheado en Redis sin consultar PostgreSQL', async () => {
      const cached = {
        id: 'user-1',
        nationalId: 'CURP1',
        isConfigured: false,
        signatureId: null,
        personalInformation: {
          rfc: 'RFC1',
          phoneNumber: null,
          secondaryEmail: null,
        },
      };
      redisService.get.mockResolvedValue(JSON.stringify(cached));

      const result = await service.getMeFromCache('CURP1');

      expect(redisService.get).toHaveBeenCalledWith('CURP1');
      expect(userRepository.findOne).not.toHaveBeenCalled();
      expect(result.data).toEqual(cached);
    });

    it('reconstruye y recachea el snapshot desde PostgreSQL si la key no existe en Redis', async () => {
      redisService.get.mockResolvedValue(null);
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        firstName: 'Juan',
        lastName: 'Pérez',
        email: 'juan@empresa.com',
        roles: ['signer'],
        nationalId: 'CURP1',
        isConfigured: false,
        signatureId: null,
        personalInformation: {
          rfc: 'RFC1',
          phoneNumber: null,
          secondaryEmail: null,
        },
      });

      const result = await service.getMeFromCache('CURP1');

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { nationalId: 'CURP1', isActive: true },
        relations: { personalInformation: true },
      });
      expect(redisService.set).toHaveBeenCalledWith(
        'CURP1',
        expect.any(String),
      );
      expect(result.data).toMatchObject({ id: 'user-1', nationalId: 'CURP1' });
    });

    it('lanza NotFoundException si no hay cache ni usuario en PostgreSQL con ese CURP', async () => {
      redisService.get.mockResolvedValue(null);
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.getMeFromCache('CURP-INEXISTENTE')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus', () => {
    it('fija isConfigured=true y refresca el cache de Redis por CURP', async () => {
      userRepository.findOne
        .mockResolvedValueOnce({
          id: 'user-1',
          nationalId: 'CURP1',
          signatureId: 'sig-1',
          personalInformation: {
            rfc: 'RFC1',
            phoneNumber: '123',
            secondaryEmail: 'a@a.com',
          },
        }) // existencia + validación
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

    it('bug corregido: lanza BadRequestException si falta información personal, sin importar lo que mande el DTO', async () => {
      userRepository.findOne.mockResolvedValueOnce({
        id: 'user-1',
        nationalId: 'CURP1',
        signatureId: 'sig-1',
        personalInformation: {
          rfc: 'RFC1',
          phoneNumber: null,
          secondaryEmail: null,
        },
      });

      await expect(
        service.updateStatus('user-1', { isConfigured: true }),
      ).rejects.toThrow(BadRequestException);
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('bug corregido: lanza BadRequestException si falta la firma digital (signatureId nulo)', async () => {
      userRepository.findOne.mockResolvedValueOnce({
        id: 'user-1',
        nationalId: 'CURP1',
        signatureId: null,
        personalInformation: {
          rfc: 'RFC1',
          phoneNumber: '123',
          secondaryEmail: 'a@a.com',
        },
      });

      await expect(
        service.updateStatus('user-1', { isConfigured: true }),
      ).rejects.toThrow(BadRequestException);
      expect(userRepository.update).not.toHaveBeenCalled();
    });
  });
});
