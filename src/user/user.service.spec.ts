import { ConflictException, NotFoundException } from '@nestjs/common';
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
      update: jest.fn(),
    },
  };
}

describe('UserService', () => {
  let service: UserService;
  let userRepository: ReturnType<typeof createMockRepository>;
  let personalInformationRepository: ReturnType<typeof createMockRepository>;
  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: ReturnType<typeof createMockQueryRunner>;
  let redisService: { set: jest.Mock; get: jest.Mock; del: jest.Mock };
  let accountService: {
    createDefaultPersonalAccount: jest.Mock;
    appendAccountToCatalog: jest.Mock;
    updateEmailForUser: jest.Mock;
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
    redisService = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
    accountService = {
      createDefaultPersonalAccount: jest.fn().mockResolvedValue({
        account: { id: 'personal-account-1' },
      }),
      appendAccountToCatalog: jest.fn(),
      updateEmailForUser: jest.fn().mockResolvedValue(undefined),
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

  describe('saveNewUser', () => {
    const dto: CreateUserDto = {
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'Juan.Perez@Empresa.com',
      roles: [UserRoles.SIGNER],
      nationalId: 'PELJ850101HDFRNN08',
      rfc: 'PELJ850101ABC',
    };

    it('guarda usuario e información personal en una sola transacción, normalizados', async () => {
      const result = await service.saveNewUser(dto);

      expect(dataSource.createQueryRunner).toHaveBeenCalled();
      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
      expect(result.email).toBe('juan.perez@empresa.com');
      expect(result.nationalId).toBe('PELJ850101HDFRNN08');
    });

    /**
     * `users.personal_information_id` es obligatorio: si el save del usuario falla con el de
     * información personal ya confirmado, queda una fila huérfana que nadie referencia.
     */
    it('hace rollback y no deja fila huérfana si falla el save del usuario', async () => {
      queryRunner.manager.save = jest
        .fn()
        .mockResolvedValueOnce({ id: 'personal-info-id' })
        .mockRejectedValueOnce(new Error('duplicate key value'));

      await expect(service.saveNewUser(dto)).rejects.toThrow(
        'duplicate key value',
      );
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });
  });

  describe('comprobaciones de unicidad', () => {
    it('assertEmailNotTaken rechaza si ya hay un usuario con ese correo', async () => {
      userRepository.findOne.mockResolvedValue({ id: 'existing-user' });

      await expect(
        service.assertEmailNotTaken('Juan.Perez@Empresa.com'),
      ).rejects.toThrow(ConflictException);
      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'juan.perez@empresa.com' },
      });
    });

    it('assertEmailNotTaken pasa si el correo está libre', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assertEmailNotTaken('nuevo@empresa.com'),
      ).resolves.toBeUndefined();
    });

    it('assertCurpNotTaken rechaza si otro usuario activo ya tiene ese CURP', async () => {
      userRepository.findOne.mockResolvedValue({ id: 'other-user' });

      await expect(
        service.assertCurpNotTaken('PELJ850101HDFRNN08'),
      ).rejects.toThrow(ConflictException);
    });

    it('assertRfcNotTaken rechaza si ya existe información personal con ese RFC', async () => {
      personalInformationRepository.findOne.mockResolvedValue({
        id: 'other-personal-info',
      });

      await expect(service.assertRfcNotTaken('PELJ850101ABC')).rejects.toThrow(
        ConflictException,
      );
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
      expect(emailService.sendRegistrationOtpNotification).toHaveBeenCalledWith(
        dto.email,
        '123456',
      );
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
      expect(emailService.sendRegistrationOtpNotification).toHaveBeenCalledWith(
        'original@empresa.com',
        '123456',
      );
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

  /**
   * Corrección de un registro sin verificar (ver historia "Permitir corregir datos antes de
   * verificar el correo"). El caso que motiva todo es el error de dedo en el correo: el código
   * se iba a una dirección inexistente y volver a registrarse tampoco servía, porque el CURP ya
   * estaba tomado por ese mismo pre-registro y `createFromSignup` reenviaba el código otra vez
   * al correo equivocado.
   */
  describe('updatePreRegistration', () => {
    const pendingUser = {
      id: 'user-1',
      email: 'ana@empresa.con',
      nationalId: 'GOMA900101MDFRNN01',
      personalInformationId: 'pi-1',
      isEmailVerified: false,
    } as never;

    beforeEach(() => {
      // Estado por defecto: el correo/CURP/RFC nuevos están libres y, tras la transacción, la
      // relectura devuelve al usuario ya actualizado.
      userRepository.findOne.mockResolvedValue(null);
      personalInformationRepository.findOne.mockResolvedValue({
        id: 'pi-1',
        rfc: 'GOMA900101XYZ',
      });
    });

    function mockReloadedUser(overrides: Record<string, unknown> = {}) {
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'ana@empresa.com',
        nationalId: 'GOMA900101MDFRNN01',
        personalInformation: { id: 'pi-1' },
        ...overrides,
      });
    }

    it('corrige el correo, lo sincroniza en las cuentas y manda un código nuevo a la dirección corregida', async () => {
      userRepository.findOne.mockResolvedValueOnce(null); // el correo nuevo está libre
      mockReloadedUser();

      const result = await service.updatePreRegistration(pendingUser, {
        email: 'Ana@Empresa.com',
      });

      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        UserEntity,
        'user-1',
        expect.objectContaining({ email: 'ana@empresa.com' }),
      );
      expect(accountService.updateEmailForUser).toHaveBeenCalledWith(
        'user-1',
        'ana@empresa.com',
        queryRunner.manager,
      );
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(emailVerificationCodeService.issue).toHaveBeenCalledWith('user-1');
      expect(emailService.sendRegistrationOtpNotification).toHaveBeenCalledWith(
        'ana@empresa.com',
        '123456',
      );
      expect(result.data.maskedEmail).toBe('a***a@empresa.com');
    });

    it('bug corregido: corregir solo el correo no manda un update vacío a información personal (TypeORM responde UpdateValuesMissingError y el endpoint devolvía 500)', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      mockReloadedUser();

      await service.updatePreRegistration(pendingUser, {
        email: 'ana@empresa.com',
      });

      const updatedEntities = queryRunner.manager.update.mock.calls.map(
        (call) => call[0],
      );
      expect(updatedEntities).toEqual([UserEntity]);
      for (const call of queryRunner.manager.update.mock.calls) {
        expect(Object.keys(call[2]).length).toBeGreaterThan(0);
      }
    });

    it('si el correo nuevo ya es de otro usuario, rechaza sin abrir la transacción', async () => {
      userRepository.findOne.mockResolvedValueOnce({ id: 'otro-usuario' });

      await expect(
        service.updatePreRegistration(pendingUser, {
          email: 'ocupado@empresa.com',
        }),
      ).rejects.toThrow(ConflictException);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('corregir solo los datos personales no dispara un código nuevo: el correo sigue siendo el mismo', async () => {
      mockReloadedUser({ email: 'ana@empresa.con' });

      await service.updatePreRegistration(pendingUser, {
        firstName: 'Ana',
        lastName: 'Gómez',
      });

      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        PersonalInformationEntity,
        'pi-1',
        expect.objectContaining({ name: 'ANA', lastName: 'GÓMEZ' }),
      );
      expect(accountService.updateEmailForUser).not.toHaveBeenCalled();
      expect(emailVerificationCodeService.issue).not.toHaveBeenCalled();
    });

    it('al corregir el CURP borra el snapshot de Redis del anterior, que quedaría huérfano', async () => {
      userRepository.findOne.mockResolvedValueOnce(null); // el CURP nuevo está libre
      mockReloadedUser({ nationalId: 'GOMA900101MDFRNN99' });

      await service.updatePreRegistration(pendingUser, {
        nationalId: 'goma900101mdfrnn99',
      });

      expect(queryRunner.manager.update).toHaveBeenCalledWith(
        UserEntity,
        'user-1',
        expect.objectContaining({ nationalId: 'GOMA900101MDFRNN99' }),
      );
      expect(redisService.del).toHaveBeenCalledWith('GOMA900101MDFRNN01');
      expect(redisService.set).toHaveBeenCalledWith(
        'GOMA900101MDFRNN99',
        expect.any(String),
      );
    });

    it('si el CURP nuevo ya es de otro usuario, rechaza', async () => {
      userRepository.findOne.mockResolvedValueOnce({ id: 'otro-usuario' });

      await expect(
        service.updatePreRegistration(pendingUser, {
          nationalId: 'GOMA900101MDFRNN99',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('si el RFC nuevo ya es de otro usuario, rechaza', async () => {
      personalInformationRepository.findOne
        .mockResolvedValueOnce({ id: 'pi-1', rfc: 'GOMA900101XYZ' })
        .mockResolvedValueOnce({ id: 'pi-de-otro' });

      await expect(
        service.updatePreRegistration(pendingUser, { rfc: 'AAAA900101XYZ' }),
      ).rejects.toThrow(ConflictException);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('si falla la escritura, revierte la transacción y no envía ningún código', async () => {
      userRepository.findOne.mockResolvedValueOnce(null);
      queryRunner.manager.update.mockRejectedValueOnce(new Error('DB caída'));

      await expect(
        service.updatePreRegistration(pendingUser, {
          email: 'ana@empresa.com',
        }),
      ).rejects.toThrow('DB caída');

      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(
        emailService.sendRegistrationOtpNotification,
      ).not.toHaveBeenCalled();
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

  describe('savePersonalInformation', () => {
    it('escribe los campos y devuelve la fila releída', async () => {
      const updated = {
        id: 'pi-1',
        phoneNumber: '5512345678',
        secondaryEmail: 'secundario@correo.com',
      };
      personalInformationRepository.findOne.mockResolvedValue(updated);

      const result = await service.savePersonalInformation('pi-1', {
        phoneNumber: '5512345678',
        secondaryEmail: 'secundario@correo.com',
      });

      expect(personalInformationRepository.update).toHaveBeenCalledWith(
        'pi-1',
        {
          phoneNumber: '5512345678',
          secondaryEmail: 'secundario@correo.com',
        },
      );
      expect(result).toBe(updated);
    });
  });

  describe('isRfcRegistered', () => {
    it('normaliza el RFC a mayúsculas antes de consultarlo', async () => {
      personalInformationRepository.findOne.mockResolvedValue({
        id: 'pi-1',
        rfc: 'PELJ850101ABC',
      });

      const result = await service.isRfcRegistered('pelj850101abc');

      expect(personalInformationRepository.findOne).toHaveBeenCalledWith({
        where: { rfc: 'PELJ850101ABC' },
      });
      expect(result).toBe(true);
    });

    it('retorna false si no existe ningún registro con ese RFC', async () => {
      personalInformationRepository.findOne.mockResolvedValue(null);

      expect(await service.isRfcRegistered('XAXX010101000')).toBe(false);
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

  describe('readCachedProfile', () => {
    it('devuelve el snapshot parseado si la key existe en Redis', async () => {
      redisService.get.mockResolvedValue(
        JSON.stringify({ id: 'user-1', isConfigured: true }),
      );

      const result = await service.readCachedProfile('CURP1');

      expect(redisService.get).toHaveBeenCalledWith('CURP1');
      expect(result).toEqual({ id: 'user-1', isConfigured: true });
    });

    /** Devolver null y no reconstruir es lo que deja al caso de uso decidir qué hacer. */
    it('devuelve null si la key no existe', async () => {
      redisService.get.mockResolvedValue(null);

      expect(await service.readCachedProfile('CURP1')).toBeNull();
    });
  });

  describe('markConfigured', () => {
    it('fija isConfigured=true sin comprobar nada más', async () => {
      await service.markConfigured('user-1');

      expect(userRepository.update).toHaveBeenCalledWith('user-1', {
        isConfigured: true,
      });
    });
  });

  describe('findOneWithPersonalInformation', () => {
    it('carga la relación de información personal', async () => {
      const user = { id: 'user-1' };
      userRepository.findOne.mockResolvedValue(user);

      const result = await service.findOneWithPersonalInformation('user-1');

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        relations: { personalInformation: true },
      });
      expect(result).toBe(user);
    });

    it('devuelve null si el usuario no existe', async () => {
      userRepository.findOne.mockResolvedValue(null);

      expect(
        await service.findOneWithPersonalInformation('missing-user'),
      ).toBeNull();
    });
  });

  describe('findActiveByNationalId', () => {
    it('filtra por CURP y por usuario activo', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await service.findActiveByNationalId('CURP1');

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { nationalId: 'CURP1', isActive: true },
        relations: { personalInformation: true },
      });
    });
  });

  describe('softDelete', () => {
    it('desactiva sin borrar la fila, para no perder la trazabilidad de firmas pasadas', async () => {
      userRepository.update.mockResolvedValue({ affected: 1 });

      await service.softDelete('user-1');

      expect(userRepository.update).toHaveBeenCalledWith(
        { id: 'user-1', isActive: true },
        { isDeleted: true, isActive: false },
      );
    });

    it('lanza NotFoundException si no había un usuario activo con ese id', async () => {
      userRepository.update.mockResolvedValue({ affected: 0 });

      await expect(service.softDelete('missing-user')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
