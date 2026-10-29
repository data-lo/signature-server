import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { OrganizationInvitationService } from './organization-invitation.service';
import { OrganizationInvitationEntity } from './entities/organization-invitation.entity';
import { AccountEntity } from './entities/account.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountService } from './account.service';
import { OrganizationInvitationEventsProducer } from 'src/kafka/organization-invitation.producer';
import { OrganizationMemberEventsProducer } from 'src/kafka/organization-member.producer';
import { INVITATION_STATUS_ENUM } from './enums/invitation-status.enum';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'saved-id', ...data })),
  };
}

/**
 * `DataSource.transaction` simulado: corre el callback con un manager que devuelve los mismos
 * repositorios simulados. No prueba el commit ni el rollback —eso es de Postgres—, sí que la
 * secuencia escriba por el manager de la transacción y no por su repositorio propio.
 */
function createMockDataSource(repositoriesByEntity: Map<unknown, unknown>) {
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      repositoriesByEntity.get(entity),
    ),
  };

  return {
    manager,
    dataSource: {
      transaction: jest.fn(async (work: (manager: unknown) => unknown) =>
        work(manager),
      ),
    },
  };
}

const ORGANIZATION = { id: 'org-1', name: 'Acme Corp' };

function pendingInvitation(
  overrides: Partial<OrganizationInvitationEntity> = {},
) {
  return {
    id: 'invitation-1',
    organizationId: 'org-1',
    roleId: 'role-1',
    invitedBy: 'admin-1',
    email: 'nuevo@empresa.com',
    token: 'token-1',
    status: INVITATION_STATUS_ENUM.PENDING,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    organization: ORGANIZATION,
    ...overrides,
  } as OrganizationInvitationEntity;
}

describe('OrganizationInvitationService', () => {
  let service: OrganizationInvitationService;
  let invitationRepository: ReturnType<typeof createMockRepository>;
  let accountRepository: ReturnType<typeof createMockRepository>;
  let organizationRepository: ReturnType<typeof createMockRepository>;
  let userRepository: ReturnType<typeof createMockRepository>;
  let accountService: { appendAccountToCatalog: jest.Mock };
  let invitationEventsProducer: { emitInvited: jest.Mock };
  let memberEventsProducer: {
    enqueueJoined: jest.Mock;
    flushOutbox: jest.Mock;
  };

  beforeEach(async () => {
    invitationRepository = createMockRepository();
    accountRepository = createMockRepository();
    organizationRepository = createMockRepository();
    userRepository = createMockRepository();
    accountService = { appendAccountToCatalog: jest.fn() };
    invitationEventsProducer = { emitInvited: jest.fn() };
    memberEventsProducer = {
      enqueueJoined: jest.fn(),
      flushOutbox: jest.fn(),
    };
    const { dataSource } = createMockDataSource(
      new Map<unknown, unknown>([
        [AccountEntity, accountRepository],
        [OrganizationInvitationEntity, invitationRepository],
      ]),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationInvitationService,
        {
          provide: getRepositoryToken(OrganizationInvitationEntity),
          useValue: invitationRepository,
        },
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
        {
          provide: getRepositoryToken(OrganizationEntity),
          useValue: organizationRepository,
        },
        { provide: getRepositoryToken(UserEntity), useValue: userRepository },
        { provide: AccountService, useValue: accountService },
        {
          provide: OrganizationInvitationEventsProducer,
          useValue: invitationEventsProducer,
        },
        {
          provide: OrganizationMemberEventsProducer,
          useValue: memberEventsProducer,
        },
        { provide: getDataSourceToken(), useValue: dataSource },
      ],
    }).compile();

    service = module.get<OrganizationInvitationService>(
      OrganizationInvitationService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const params = {
      organizationId: 'org-1',
      roleId: 'role-1',
      invitedBy: 'admin-1',
      email: 'Nuevo@Empresa.com',
    };

    it('lanza NotFoundException si la organización no existe', async () => {
      organizationRepository.findOne.mockResolvedValue(null);

      await expect(service.create(params)).rejects.toThrow(NotFoundException);
      expect(invitationRepository.save).not.toHaveBeenCalled();
    });

    it('persiste la invitación PENDING (email en minúsculas) y publica el evento con el token generado', async () => {
      organizationRepository.findOne.mockResolvedValue(ORGANIZATION);

      await service.create(params);

      expect(invitationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          roleId: 'role-1',
          invitedBy: 'admin-1',
          email: 'nuevo@empresa.com',
          status: INVITATION_STATUS_ENUM.PENDING,
        }),
      );
      const [savedInvitation] = invitationRepository.save.mock.calls[0];
      expect(invitationEventsProducer.emitInvited).toHaveBeenCalledWith({
        email: 'nuevo@empresa.com',
        organizationId: 'org-1',
        organizationName: 'Acme Corp',
        roleId: 'role-1',
        invitationToken: savedInvitation.token,
        invitedBy: 'admin-1',
      });
    });
  });

  describe('acceptByRfc', () => {
    /** Usuario con cuenta registrada con un correo DISTINTO al de la invitación. */
    const PERSONAL_EMAIL_USER = {
      id: 'user-2',
      email: 'ana.personal@gmail.com',
      password: 'hashed-pw-2',
    };

    /**
     * El corazón de la historia: la invitación se mandó a `nuevo@empresa.com`, pero la persona
     * tiene su cuenta con el correo personal. Se une igual, porque la identidad la da el RFC y
     * el correo de la invitación es sólo el canal de entrega.
     */
    it('crea la membresía sin comparar el correo de la invitación con el de la cuenta', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue(PERSONAL_EMAIL_USER);
      accountRepository.findOne.mockResolvedValue(null);

      await service.acceptByRfc('token-1', 'XAXX010101000');

      expect(accountRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-2',
          organizationId: 'org-1',
          roleId: 'role-1',
          isActive: true,
        }),
      );
    });

    it('busca al usuario por RFC en mayúsculas', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue(PERSONAL_EMAIL_USER);
      accountRepository.findOne.mockResolvedValue(null);

      await service.acceptByRfc('token-1', 'xaxx010101000');

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { personalInformation: { rfc: 'XAXX010101000' } },
        relations: { personalInformation: true },
      });
    });

    it('marca la invitación como ACCEPTED', async () => {
      const invitation = pendingInvitation();
      invitationRepository.findOne.mockResolvedValue(invitation);
      userRepository.findOne.mockResolvedValue(PERSONAL_EMAIL_USER);
      accountRepository.findOne.mockResolvedValue(null);

      await service.acceptByRfc('token-1', 'XAXX010101000');

      expect(invitationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: INVITATION_STATUS_ENUM.ACCEPTED }),
      );
    });

    it('lanza NotFoundException si no hay cuenta con ese RFC, sin crear nada', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.acceptByRfc('token-1', 'XAXX010101000'),
      ).rejects.toThrow(NotFoundException);
      expect(accountRepository.save).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si el token no existe', async () => {
      invitationRepository.findOne.mockResolvedValue(null);

      await expect(
        service.acceptByRfc('token-inexistente', 'XAXX010101000'),
      ).rejects.toThrow(NotFoundException);
    });

    it('lanza ConflictException si la invitación ya se usó', async () => {
      invitationRepository.findOne.mockResolvedValue(
        pendingInvitation({ status: INVITATION_STATUS_ENUM.ACCEPTED }),
      );

      await expect(
        service.acceptByRfc('token-1', 'XAXX010101000'),
      ).rejects.toThrow(ConflictException);
      expect(accountRepository.save).not.toHaveBeenCalled();
    });

    /** La expiración se aplica al leerla: una invitación vencida pero aún PENDING se rechaza. */
    it('lanza GoneException si la invitación ya expiró', async () => {
      invitationRepository.findOne.mockResolvedValue(
        pendingInvitation({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.acceptByRfc('token-1', 'XAXX010101000'),
      ).rejects.toThrow(GoneException);
      expect(accountRepository.save).not.toHaveBeenCalled();
    });

    it('lanza ConflictException si la persona ya es miembro activo de la organización', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue(PERSONAL_EMAIL_USER);
      accountRepository.findOne.mockResolvedValue({ id: 'existing-account' });

      await expect(
        service.acceptByRfc('token-1', 'XAXX010101000'),
      ).rejects.toThrow(ConflictException);
      expect(accountRepository.save).not.toHaveBeenCalled();
    });
  });
});
