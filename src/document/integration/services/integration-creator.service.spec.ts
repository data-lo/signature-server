import { DataSource, QueryFailedError } from 'typeorm';

import { AccountMemberService } from 'src/account/account-member.service';
import { AccountService } from 'src/account/account.service';
import { AccountEntity } from 'src/account/entities/account.entity';
import { OrganizationMemberEventsProducer } from 'src/kafka/organization-member.producer';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';
import { RolesService } from 'src/roles/roles.service';
import { UserEntity } from 'src/user/entities/user.entity';
import { USER_LIFECYCLE_STATUS_ENUM } from 'src/user/enums/user-lifecycle-status.enum';

import {
  IntegrationCreatorMembershipRevokedException,
  IntegrationCreatorUnavailableException,
} from '../exceptions/integration-document.exceptions';
import { IntegrationCreatorService } from './integration-creator.service';

const PARAMS = {
  organizationId: 'org-1',
  email: '  Ana@Cliente.COM ',
  firstName: 'ana',
  lastName: 'lópez',
  actorUserId: 'user-actor',
};

describe('IntegrationCreatorService', () => {
  let users: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let accounts: { findOne: jest.Mock; find: jest.Mock };
  let manager: { getRepository: jest.Mock };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };
  let accountService: {
    createDefaultPersonalAccount: jest.Mock;
    appendAccountToCatalog: jest.Mock;
  };
  let accountMemberService: { saveMembership: jest.Mock };
  let rolesService: { findSystemRoleByName: jest.Mock };
  let memberEvents: { enqueueJoined: jest.Mock; flushOutbox: jest.Mock };
  let service: IntegrationCreatorService;

  const membership = {
    id: 'account-ana-org1',
    userId: 'user-ana',
    organizationId: 'org-1',
    isActive: true,
  } as AccountEntity;

  beforeEach(() => {
    users = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (user) => ({ id: 'user-ana', ...user })),
    };
    accounts = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest
        .fn()
        .mockResolvedValue([
          { id: 'account-ana-personal', organizationId: null },
          membership,
        ]),
    };
    manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === UserEntity ? users : accounts,
      ),
    };
    dataSource = {
      transaction: jest.fn((work) => work(manager)),
      getRepository: jest.fn(() => accounts),
    };
    accountService = {
      createDefaultPersonalAccount: jest
        .fn()
        .mockResolvedValue({ account: { id: 'account-ana-personal' } }),
      appendAccountToCatalog: jest.fn().mockResolvedValue(undefined),
    };
    accountMemberService = {
      saveMembership: jest.fn().mockResolvedValue(membership),
    };
    rolesService = {
      findSystemRoleByName: jest
        .fn()
        .mockResolvedValue({ id: 'role-integration-creator' }),
    };
    memberEvents = {
      enqueueJoined: jest.fn().mockResolvedValue(undefined),
      flushOutbox: jest.fn().mockResolvedValue(undefined),
    };

    service = new IntegrationCreatorService(
      dataSource as unknown as DataSource,
      accountService as unknown as AccountService,
      accountMemberService as unknown as AccountMemberService,
      rolesService as unknown as RolesService,
      memberEvents as unknown as OrganizationMemberEventsProducer,
    );
  });

  describe('el correo no existe', () => {
    it('crea un usuario PROVISIONED sin credenciales, buscando por el correo normalizado', async () => {
      const result = await service.resolve(PARAMS);

      expect(users.findOne).toHaveBeenCalledWith({
        where: { email: 'ana@cliente.com' },
      });
      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'ana@cliente.com',
          firstName: 'Ana',
          lastName: 'López',
          lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
          nationalId: null,
          password: null,
          personalInformationId: null,
          isEmailVerified: false,
        }),
      );
      expect(result.provisioned).toEqual({ user: true, membership: true });
    });

    it('le crea cuenta personal y membresía con el rol mínimo, en la misma transacción', async () => {
      await service.resolve(PARAMS);

      expect(accountService.createDefaultPersonalAccount).toHaveBeenCalledWith(
        manager,
        'user-ana',
        'ana@cliente.com',
        null,
      );
      expect(rolesService.findSystemRoleByName).toHaveBeenCalledWith(
        SYSTEM_ROLE_NAME_ENUM.INTEGRATION_DOCUMENT_CREATOR,
      );
      expect(accountMemberService.saveMembership).toHaveBeenCalledWith(
        {
          organizationId: 'org-1',
          userId: 'user-ana',
          roleId: 'role-integration-creator',
        },
        expect.objectContaining({ id: 'user-ana' }),
        manager,
      );
      expect(memberEvents.enqueueJoined).toHaveBeenCalledWith(manager, {
        membership,
        actorUserId: 'user-actor',
      });
    });

    it('después del commit publica el alta y suma las dos cuentas al catálogo', async () => {
      await service.resolve(PARAMS);

      expect(memberEvents.flushOutbox).toHaveBeenCalled();
      expect(accountService.appendAccountToCatalog).toHaveBeenCalledTimes(2);
    });
  });

  describe('el correo existe', () => {
    const existing = {
      id: 'user-ana',
      email: 'ana@cliente.com',
      firstName: 'Ana María',
      isActive: true,
      isDeleted: false,
    };

    beforeEach(() => users.findOne.mockResolvedValue(existing));

    it('con membresía activa la usa tal cual, sin tocar nada', async () => {
      accounts.findOne.mockResolvedValue(membership);

      const result = await service.resolve(PARAMS);

      expect(result).toMatchObject({
        user: existing,
        account: membership,
        provisioned: { user: false, membership: false },
      });
      expect(users.save).not.toHaveBeenCalled();
      expect(accountMemberService.saveMembership).not.toHaveBeenCalled();
      expect(memberEvents.flushOutbox).not.toHaveBeenCalled();
    });

    it('sin membresía le crea una, sin sobrescribir sus datos ni crearle otra cuenta personal', async () => {
      const result = await service.resolve(PARAMS);

      expect(users.save).not.toHaveBeenCalled();
      expect(
        accountService.createDefaultPersonalAccount,
      ).not.toHaveBeenCalled();
      expect(accountMemberService.saveMembership).toHaveBeenCalled();
      expect(result.provisioned).toEqual({ user: false, membership: true });
      expect(accountService.appendAccountToCatalog).toHaveBeenCalledTimes(1);
    });

    it('con la membresía dada de baja, no la reactiva', async () => {
      accounts.findOne.mockResolvedValue({ ...membership, isActive: false });

      await expect(service.resolve(PARAMS)).rejects.toBeInstanceOf(
        IntegrationCreatorMembershipRevokedException,
      );
      expect(accountMemberService.saveMembership).not.toHaveBeenCalled();
    });

    it.each([
      ['desactivado', { isActive: false }],
      ['borrado', { isDeleted: true }],
    ])('rechaza un usuario %s', async (_label, patch) => {
      users.findOne.mockResolvedValue({ ...existing, ...patch });

      await expect(service.resolve(PARAMS)).rejects.toBeInstanceOf(
        IntegrationCreatorUnavailableException,
      );
    });
  });

  it('si otra petición creó al mismo usuario a la vez, lo vuelve a leer y lo usa', async () => {
    const duplicate = new QueryFailedError('insert', [], new Error('dup'));
    Object.assign(duplicate, {
      driverError: {
        code: '23505',
        constraint: 'UQ_97672ac88f789774dd47f7c8be3',
      },
    });
    dataSource.transaction
      .mockRejectedValueOnce(duplicate)
      .mockImplementationOnce((work) => work(manager));
    users.findOne.mockResolvedValue({
      id: 'user-ana',
      email: 'ana@cliente.com',
      isActive: true,
      isDeleted: false,
    });
    accounts.findOne.mockResolvedValue(membership);

    const result = await service.resolve(PARAMS);

    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(result.account).toBe(membership);
  });

  describe('resolveProvisionalSigner (firmantes de firma simple)', () => {
    const identity = {
      email: 'beto@acme.mx',
      firstName: 'beto',
      lastName: 'ruiz',
    };

    it('un correo sin usuario: crea el usuario PROVISIONED con el mismo aprovisionamiento y devuelve su cuenta personal', async () => {
      accounts.findOne.mockResolvedValue({ id: 'account-beto-personal' });

      await expect(
        service.resolveProvisionalSigner(manager as never, identity),
      ).resolves.toBe('account-beto-personal');

      expect(users.save).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'beto@acme.mx',
          lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
          password: null,
          nationalId: null,
        }),
      );
      expect(accountService.createDefaultPersonalAccount).toHaveBeenCalled();
      // No es miembro de la organización: sólo firma.
      expect(accountMemberService.saveMembership).not.toHaveBeenCalled();
    });

    it('un usuario PROVISIONED existente se reutiliza', async () => {
      users.findOne.mockResolvedValue({
        id: 'user-beto',
        lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
        isActive: true,
        isDeleted: false,
      });
      accounts.findOne.mockResolvedValue({ id: 'account-beto-personal' });

      await expect(
        service.resolveProvisionalSigner(manager as never, identity),
      ).resolves.toBe('account-beto-personal');
      expect(users.save).not.toHaveBeenCalled();
    });

    it.each([
      [
        'ACTIVE',
        {
          lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.ACTIVE,
          isActive: true,
          isDeleted: false,
        },
      ],
      [
        'inactivo',
        {
          lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
          isActive: false,
          isDeleted: false,
        },
      ],
      [
        'borrado',
        {
          lifecycleStatus: USER_LIFECYCLE_STATUS_ENUM.PROVISIONED,
          isActive: true,
          isDeleted: true,
        },
      ],
    ])(
      'un usuario %s no se vincula (firma desde su cuenta, o no firma)',
      async (_case, user) => {
        users.findOne.mockResolvedValue({ id: 'user-beto', ...user });
        await expect(
          service.resolveProvisionalSigner(manager as never, identity),
        ).resolves.toBeNull();
        expect(users.save).not.toHaveBeenCalled();
      },
    );
  });
});
