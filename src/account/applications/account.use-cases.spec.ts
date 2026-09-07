import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { AccountService } from '../account.service';
import { AccountEntity } from '../entities/account.entity';
import { OrganizationEntity } from '../entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { RedisService } from 'src/shared/redis/redis.service';
import { ACCOUNT_TYPE_ENUM } from '../enums/account-type.enum';
import { RolesService } from 'src/roles/roles.service';
import { BillingProfileProvisioningService } from 'src/billing/profiles/billing-profile-provisioning.service';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { OrganizationInvitationService } from '../organization-invitation.service';

import { CreateOrganizationUseCase } from './create-organization.use-case';
import { UpdateAccountUseCase } from './update-account.use-case';
import { GetAccountUseCase } from './get-account.use-case';
import { InviteOrganizationMemberUseCase } from './invite-organization-member.use-case';

const ADMIN_ROLE = { id: 'admin-role-1', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };
const CURRENT_USER = {
  id: 'user-1',
  email: 'user1@empresa.com',
  password: 'hashed-pw',
};

function createMockRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => data),
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

/**
 * Los casos de uso se montan sobre el `AccountService` real con repositorios simulados: lo que
 * se prueba acá es la secuencia completa —comprobar permisos, escribir, refrescar el catálogo—
 * y con el servicio también simulado no quedaría nada de eso bajo prueba.
 */
describe('casos de uso de cuentas y organizaciones', () => {
  let accountRepository: ReturnType<typeof createMockRepository>;
  let organizationRepository: ReturnType<typeof createMockRepository>;
  let userRepository: ReturnType<typeof createMockRepository>;
  let dataSource: { createQueryRunner: jest.Mock };
  let queryRunner: ReturnType<typeof createMockQueryRunner>;
  let redisService: { set: jest.Mock; get: jest.Mock };
  let rolesService: {
    findSystemRoleByName: jest.Mock;
    findByIdOrFail: jest.Mock;
    hasPermission: jest.Mock;
  };
  let organizationInvitationService: { create: jest.Mock };

  let createOrganization: CreateOrganizationUseCase;
  let updateAccount: UpdateAccountUseCase;
  let getAccount: GetAccountUseCase;
  let inviteOrganizationMember: InviteOrganizationMemberUseCase;

  beforeEach(async () => {
    accountRepository = createMockRepository();
    organizationRepository = createMockRepository();
    userRepository = createMockRepository();
    userRepository.findOne.mockResolvedValue(CURRENT_USER);
    queryRunner = createMockQueryRunner();
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };
    redisService = { set: jest.fn(), get: jest.fn() };
    rolesService = {
      findSystemRoleByName: jest.fn().mockResolvedValue(ADMIN_ROLE),
      findByIdOrFail: jest.fn().mockResolvedValue({ id: 'member-role-1' }),
      // Espeja el seed real: ADMIN tiene los 12 permisos (incluye todo ORGANIZATION),
      // cualquier otro rol (o su ausencia) no tiene ninguno — ver RolesService.hasPermission.
      hasPermission: jest
        .fn()
        .mockImplementation(
          async (roleId: string | null | undefined) => roleId === ADMIN_ROLE.id,
        ),
    };
    organizationInvitationService = {
      create: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        CreateOrganizationUseCase,
        UpdateAccountUseCase,
        GetAccountUseCase,
        InviteOrganizationMemberUseCase,
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        {
          provide: getRepositoryToken(OrganizationEntity),
          useValue: organizationRepository,
        },
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: RedisService, useValue: redisService },
        { provide: RolesService, useValue: rolesService },
        {
          // Toda cuenta nace con su perfil Free; acá sólo interesa que el alta siga funcionando,
          // el contenido del perfil lo cubre `BillingProfileProvisioningService`.
          provide: BillingProfileProvisioningService,
          useValue: {
            provisionFreeProfile: jest
              .fn()
              .mockResolvedValue({ id: 'perfil-free-1' }),
          },
        },
        {
          provide: OrganizationInvitationService,
          useValue: organizationInvitationService,
        },
      ],
    }).compile();

    createOrganization = module.get(CreateOrganizationUseCase);
    updateAccount = module.get(UpdateAccountUseCase);
    getAccount = module.get(GetAccountUseCase);
    inviteOrganizationMember = module.get(InviteOrganizationMemberUseCase);
  });

  describe('CreateOrganizationUseCase', () => {
    const dto = { name: 'Acme', organizationName: 'Acme Corp S.A. de C.V.' };

    function mockFullAccountLookup() {
      accountRepository.findOne.mockResolvedValue({
        id: 'generated-id',
        accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        organizationId: 'generated-id-org',
        roleId: 'admin-role-1',
        isActive: true,
        createdAt: new Date('2026-01-01'),
        organization: { name: 'Acme Corp S.A. de C.V.' },
      });
    }

    it('crea Organization + Account(rol ADMIN) dentro de una transaccion y refresca el catalogo en Redis', async () => {
      mockFullAccountLookup();
      redisService.get.mockResolvedValue(null);

      const result = await createOrganization.execute('user-1', dto);

      expect(dataSource.createQueryRunner).toHaveBeenCalled();
      expect(queryRunner.startTransaction).toHaveBeenCalled();
      expect(queryRunner.manager.save).toHaveBeenCalledTimes(2);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();

      const accountSaveCall = queryRunner.manager.save.mock.calls[1][0];
      expect(accountSaveCall.roleId).toBe('admin-role-1');
      expect(accountSaveCall.userId).toBe('user-1');
      expect(accountSaveCall.isActive).toBe(true);
      expect(accountSaveCall.email).toBe('user1@empresa.com');
      expect(accountSaveCall.password).toBe('hashed-pw');

      const [, cachedValue] = redisService.set.mock.calls[0];
      const cachedCatalog = JSON.parse(cachedValue);
      expect(cachedCatalog[0].roleId).toBe('admin-role-1');
      expect(cachedCatalog[0].isActive).toBe(true);
      expect(result.success).toBe(true);
      expect(result.data.roleId).toBe('admin-role-1');
      expect(result.data.isActive).toBe(true);
    });

    it('persiste los campos opcionales de perfil de organizacion cuando se envian', async () => {
      mockFullAccountLookup();
      redisService.get.mockResolvedValue(null);

      await createOrganization.execute('user-1', {
        ...dto,
        address: 'Av. Reforma 123, CDMX',
        rfc: 'ACM010101AAA',
        domainAllowed: 'acme.com',
        phoneNumber: '5512345678',
        indexDocuments: true,
      });

      expect(queryRunner.manager.save.mock.calls[0][0]).toMatchObject({
        address: 'Av. Reforma 123, CDMX',
        rfc: 'ACM010101AAA',
        domainAllowed: 'acme.com',
        phoneNumber: '5512345678',
        indexDocuments: true,
      });
    });

    it('defaultea los campos opcionales de perfil de organizacion a null/false cuando se omiten', async () => {
      mockFullAccountLookup();
      redisService.get.mockResolvedValue(null);

      await createOrganization.execute('user-1', dto);

      expect(queryRunner.manager.save.mock.calls[0][0]).toMatchObject({
        address: null,
        rfc: null,
        domainAllowed: null,
        phoneNumber: null,
        indexDocuments: false,
      });
    });

    it('hace rollback si falla la creacion de la cuenta', async () => {
      queryRunner.manager.save = jest
        .fn()
        .mockResolvedValueOnce({ id: 'org-1' })
        .mockRejectedValueOnce(new Error('duplicate key value'));

      await expect(createOrganization.execute('user-1', dto)).rejects.toThrow(
        'duplicate key value',
      );
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();
    });

    it('lanza NotFoundException si el usuario no existe, sin abrir la transaccion', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        createOrganization.execute('missing-user', dto),
      ).rejects.toThrow(NotFoundException);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });
  });

  describe('UpdateAccountUseCase', () => {
    const adminAccount = {
      id: 'account-1',
      userId: 'owner-1',
      accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationId: 'org-1',
      roleId: 'admin-role-1',
      role: ADMIN_ROLE,
      isActive: true,
      createdAt: new Date('2026-01-01'),
      organization: { name: 'Acme Corp S.A. de C.V.' },
    };
    const renamedAccount = {
      ...adminAccount,
      organization: { name: 'Acme Renombrada S.A. de C.V.' },
    };

    it('refresca el catalogo de cada miembro activo cuando cambia el nombre de la organizacion', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce(adminAccount)
        .mockResolvedValueOnce(renamedAccount);
      accountRepository.find.mockResolvedValue([
        {
          id: 'account-1',
          userId: 'user-1',
          organizationId: 'org-1',
          isActive: true,
        },
        {
          id: 'account-2',
          userId: 'user-2',
          organizationId: 'org-1',
          isActive: true,
        },
      ]);
      redisService.get.mockResolvedValue(
        JSON.stringify([
          { id: 'account-1', roleId: 'admin-role-1', isActive: true },
        ]),
      );

      await updateAccount.execute('owner-1', 'account-1', {
        organizationName: 'Acme Renombrada S.A. de C.V.',
      });

      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', isActive: true },
        relations: { organization: true },
      });
      expect(redisService.set).toHaveBeenCalled();
    });

    it('no toca Redis si no se actualizo ningun campo de perfil', async () => {
      accountRepository.findOne
        .mockResolvedValueOnce(adminAccount)
        .mockResolvedValueOnce(adminAccount);

      await updateAccount.execute('owner-1', 'account-1', {});

      expect(accountRepository.find).not.toHaveBeenCalled();
      expect(redisService.set).not.toHaveBeenCalled();
    });

    /** Una cuenta personal no tiene perfil de organizacion que editar. */
    it('no escribe en organizations si la cuenta es PERSONAL', async () => {
      const personalAccount = {
        ...adminAccount,
        accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
        organizationId: null,
      };
      accountRepository.findOne
        .mockResolvedValueOnce(personalAccount)
        .mockResolvedValueOnce(personalAccount);

      await updateAccount.execute('owner-1', 'account-1', {
        organizationName: 'Da igual',
      });

      expect(organizationRepository.update).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la cuenta', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        updateAccount.execute('intruder', 'account-1', {
          organizationName: 'Hackeada',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('GetAccountUseCase', () => {
    it('retorna la cuenta si el llamador es ADMIN activo (dueno de esa fila)', async () => {
      accountRepository.findOne.mockResolvedValue({
        id: 'account-1',
        userId: 'owner-1',
        accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
        organizationId: 'org-1',
        roleId: 'admin-role-1',
        role: ADMIN_ROLE,
        isActive: true,
        createdAt: new Date('2026-01-01'),
        organization: { name: 'Acme Corp S.A. de C.V.' },
      });

      const result = await getAccount.execute('owner-1', 'account-1');

      expect(result.data.id).toBe('account-1');
    });

    it('lanza ForbiddenException si el llamador no es ADMIN activo de la cuenta', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(getAccount.execute('intruder', 'account-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('InviteOrganizationMemberUseCase', () => {
    const dto = { email: 'nuevo@empresa.com', roleId: 'member-role-1' };
    const adminOrgAccount = {
      id: 'org-account-1',
      userId: 'admin-1',
      accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
      organizationId: 'org-1',
      roleId: ADMIN_ROLE.id,
      role: ADMIN_ROLE,
      isActive: true,
    };
    const adminPersonalAccount = {
      id: 'personal-account-1',
      userId: 'admin-1',
      accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
      organizationId: null,
      roleId: ADMIN_ROLE.id,
      role: ADMIN_ROLE,
      isActive: true,
    };

    /**
     * La invitación se persiste con el `organizationId` resuelto desde la membresía, no con el
     * `accountId` del header: son identificadores distintos y confundirlos invitaría a la
     * organización equivocada.
     */
    it('persiste la invitacion con el organizationId resuelto desde la membresia del llamador', async () => {
      accountRepository.findOne.mockResolvedValue(adminOrgAccount);

      const result = await inviteOrganizationMember.execute(
        'admin-1',
        'org-account-1',
        dto,
      );

      expect(rolesService.findByIdOrFail).toHaveBeenCalledWith('member-role-1');
      expect(organizationInvitationService.create).toHaveBeenCalledWith({
        organizationId: 'org-1',
        roleId: 'member-role-1',
        invitedBy: 'admin-1',
        email: 'nuevo@empresa.com',
      });
      expect(result).toEqual({
        success: true,
        message: 'Invitación enviada correctamente',
        data: null,
      });
    });

    it('lanza BadRequestException si falta accountId (header X-Account-Id)', async () => {
      await expect(
        inviteOrganizationMember.execute('admin-1', '', dto),
      ).rejects.toThrow(BadRequestException);
      expect(accountRepository.findOne).not.toHaveBeenCalled();
      expect(organizationInvitationService.create).not.toHaveBeenCalled();
    });

    it('lanza ForbiddenException si el llamador no es ADMIN de la cuenta', async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await expect(
        inviteOrganizationMember.execute('intruder', 'org-account-1', dto),
      ).rejects.toThrow(ForbiddenException);
      expect(organizationInvitationService.create).not.toHaveBeenCalled();
    });

    it('lanza BadRequestException si la cuenta activa no es de tipo ORGANIZATION', async () => {
      accountRepository.findOne.mockResolvedValue(adminPersonalAccount);

      await expect(
        inviteOrganizationMember.execute('admin-1', 'personal-account-1', dto),
      ).rejects.toThrow(BadRequestException);
      expect(rolesService.findByIdOrFail).not.toHaveBeenCalled();
    });

    /**
     * Si el rol no existe, la invitación reventaría al canjearse: en ese momento ya no hay
     * quien corrija el error, porque el invitado no eligió ese rol.
     */
    it('no persiste nada si el roleId no corresponde a un rol existente', async () => {
      accountRepository.findOne.mockResolvedValue(adminOrgAccount);
      rolesService.findByIdOrFail.mockRejectedValue(
        new NotFoundException('Rol con ID bad-role no encontrado'),
      );

      await expect(
        inviteOrganizationMember.execute('admin-1', 'org-account-1', {
          ...dto,
          roleId: 'bad-role',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(organizationInvitationService.create).not.toHaveBeenCalled();
    });
  });
});
