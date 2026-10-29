import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AccountEntity } from 'src/account/entities/account.entity';
import { EmailService } from 'src/common/email/email.service';
import { IdempotencyService } from 'src/event/idempotency.service';
import { RoleEntity } from 'src/roles/entities/role.entity';
import { SYSTEM_ROLE_NAME_ENUM } from 'src/roles/enums/system-role-name.enum';

import { OrganizationMemberEventsConsumer } from '../organization-member-events.controller';
import type { OrganizationMemberJoinedEventPayload } from '../organization-member.topics';
import { NotifyOrganizationAdminsOfNewMemberUseCase } from './notify-organization-admins-of-new-member.use-case';

const OWNER_ROLE = { id: 'owner-role-1', name: SYSTEM_ROLE_NAME_ENUM.OWNER };
const ADMIN_ROLE = { id: 'admin-role-1', name: SYSTEM_ROLE_NAME_ENUM.ADMIN };
const MEMBER_ROLE = { id: 'member-role-1', name: SYSTEM_ROLE_NAME_ENUM.MEMBER };

const ORGANIZATION = { id: 'org-1', name: 'Acme Corp' };

const payload: OrganizationMemberJoinedEventPayload = {
  eventId: 'event-1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  actorUserId: 'owner-1',
  organizationId: ORGANIZATION.id,
  accountId: 'account-nuevo',
  memberUserId: 'user-nuevo',
  roleId: MEMBER_ROLE.id,
};

/** Membresía del recién llegado, tal como la devuelve el repositorio con sus relaciones. */
function joinedMembership(overrides: Partial<AccountEntity> = {}) {
  return {
    id: 'account-nuevo',
    userId: 'user-nuevo',
    organizationId: ORGANIZATION.id,
    organization: ORGANIZATION,
    roleId: MEMBER_ROLE.id,
    role: MEMBER_ROLE,
    email: 'luis@empresa.com',
    user: {
      id: 'user-nuevo',
      firstName: 'Luis',
      lastName: 'Pérez',
      email: 'luis@empresa.com',
    },
    ...overrides,
  } as unknown as AccountEntity;
}

function administrator(
  id: string,
  userId: string,
  firstName: string,
  email: string,
  roleId: string,
) {
  return {
    id,
    userId,
    organizationId: ORGANIZATION.id,
    roleId,
    email,
    user: { id: userId, firstName, lastName: 'Ruiz', email },
  } as unknown as AccountEntity;
}

const OWNER = administrator(
  'account-owner',
  'owner-1',
  'Ana',
  'ana@empresa.com',
  OWNER_ROLE.id,
);
const ADMIN = administrator(
  'account-admin',
  'admin-1',
  'Beto',
  'beto@empresa.com',
  ADMIN_ROLE.id,
);

const MEMBERS_URL =
  'https://app.ejemplo.com/dashboard/organizations/org-1/members';

describe('OrganizationMemberEventsConsumer', () => {
  let consumer: OrganizationMemberEventsConsumer;
  let accountRepository: { findOne: jest.Mock; find: jest.Mock };
  let roleRepository: { find: jest.Mock };
  let emailService: { sendOrganizationMemberJoinedNotification: jest.Mock };
  let idempotency: { claim: jest.Mock; release: jest.Mock };

  // La base del frontend se lee de `process.env` (vía `frontendBaseUrl`), igual que el resto de
  // los enlaces que viajan por correo.
  const originalFrontendUrl = process.env.FRONTEND_URL;

  beforeEach(async () => {
    process.env.FRONTEND_URL = 'https://app.ejemplo.com';

    accountRepository = {
      findOne: jest.fn().mockResolvedValue(joinedMembership()),
      find: jest.fn().mockResolvedValue([OWNER, ADMIN]),
    };
    roleRepository = {
      find: jest.fn().mockResolvedValue([OWNER_ROLE, ADMIN_ROLE]),
    };
    emailService = {
      sendOrganizationMemberJoinedNotification: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    idempotency = {
      claim: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrganizationMemberEventsConsumer],
      providers: [
        NotifyOrganizationAdminsOfNewMemberUseCase,
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        { provide: getRepositoryToken(RoleEntity), useValue: roleRepository },
        { provide: EmailService, useValue: emailService },
        { provide: IdempotencyService, useValue: idempotency },
      ],
    }).compile();

    consumer = module.get(OrganizationMemberEventsConsumer);
  });

  afterEach(() => {
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  const sent = () => emailService.sendOrganizationMemberJoinedNotification;

  it('manda un correo a cada OWNER y ADMIN activo, con el nombre, el correo, el rol y el enlace a miembros', async () => {
    await consumer.handleJoined(payload);

    expect(sent()).toHaveBeenCalledTimes(2);
    expect(sent()).toHaveBeenNthCalledWith(
      1,
      'ana@empresa.com',
      'Ana Ruiz',
      'Luis Pérez',
      'luis@empresa.com',
      'Acme Corp',
      SYSTEM_ROLE_NAME_ENUM.MEMBER,
      MEMBERS_URL,
    );
    expect(sent()).toHaveBeenNthCalledWith(
      2,
      'beto@empresa.com',
      'Beto Ruiz',
      'Luis Pérez',
      'luis@empresa.com',
      'Acme Corp',
      SYSTEM_ROLE_NAME_ENUM.MEMBER,
      MEMBERS_URL,
    );
  });

  /**
   * El filtro por rol y la exclusión del recién llegado viajan en la consulta, así que lo que se
   * comprueba es la consulta: si el `In(...)` o el `Not(...)` desaparecieran, un miembro raso —o
   * el propio invitado, si le tocó rol de administrador— recibiría el aviso.
   */
  it('busca sólo miembros activos con rol de sistema OWNER/ADMIN y excluye al que se acaba de unir', async () => {
    await consumer.handleJoined(payload);

    expect(roleRepository.find.mock.calls[0][0].where).toMatchObject({
      name: {
        _value: [SYSTEM_ROLE_NAME_ENUM.OWNER, SYSTEM_ROLE_NAME_ENUM.ADMIN],
      },
      isSystemRole: true,
    });

    const where = accountRepository.find.mock.calls[0][0].where;
    expect(where).toMatchObject({
      organizationId: ORGANIZATION.id,
      isActive: true,
      roleId: { _value: [OWNER_ROLE.id, ADMIN_ROLE.id] },
      userId: { _value: 'user-nuevo' },
    });
  });

  it('no manda nada si la organización no tiene propietarios ni administradores activos', async () => {
    accountRepository.find.mockResolvedValue([]);

    await consumer.handleJoined(payload);

    expect(sent()).not.toHaveBeenCalled();
  });

  it('no manda nada si los roles de sistema no están sembrados', async () => {
    roleRepository.find.mockResolvedValue([]);

    await consumer.handleJoined(payload);

    expect(accountRepository.find).not.toHaveBeenCalled();
    expect(sent()).not.toHaveBeenCalled();
  });

  it('reclama la marca por destinatario y salta a quien ya la tenía (reentrega del mismo evento)', async () => {
    idempotency.claim.mockImplementation(
      async (_eventId: string, consumerKey: string) =>
        consumerKey !== 'organization-member-joined:account-owner',
    );

    await consumer.handleJoined(payload);

    expect(idempotency.claim).toHaveBeenCalledWith(
      'event-1',
      'organization-member-joined:account-owner',
    );
    expect(sent()).toHaveBeenCalledTimes(1);
    expect(sent().mock.calls[0][0]).toBe('beto@empresa.com');
  });

  /**
   * El fallo de uno no debe costarle el aviso a los demás ni quedar marcado como hecho: se suelta
   * sólo su marca, para que una reentrega del evento lo reintente a él y nada más.
   */
  it('suelta la marca del destinatario cuyo correo falló y sigue con el resto', async () => {
    sent().mockImplementation(async (to: string) => {
      if (to === 'ana@empresa.com') throw new Error('SendGrid caído');
    });

    await expect(consumer.handleJoined(payload)).resolves.toBeUndefined();

    expect(idempotency.release).toHaveBeenCalledTimes(1);
    expect(idempotency.release).toHaveBeenCalledWith(
      'event-1',
      'organization-member-joined:account-owner',
    );
    expect(sent()).toHaveBeenCalledTimes(2);
  });

  it('descarta el aviso —sin tumbarse— si la membresía del evento ya no existe', async () => {
    accountRepository.findOne.mockResolvedValue(null);

    await expect(consumer.handleJoined(payload)).resolves.toBeUndefined();

    expect(sent()).not.toHaveBeenCalled();
  });

  it('nombra el rol como pendiente en vez de fallar cuando la membresía todavía no tiene uno', async () => {
    accountRepository.findOne.mockResolvedValue(
      joinedMembership({ roleId: null, role: null }),
    );

    await consumer.handleJoined(payload);

    expect(sent().mock.calls[0][5]).toBe('Sin rol asignado');
  });
});
