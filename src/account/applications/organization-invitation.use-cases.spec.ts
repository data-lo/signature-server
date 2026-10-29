import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { OrganizationInvitationService } from '../organization-invitation.service';
import { OrganizationInvitationEntity } from '../entities/organization-invitation.entity';
import { AccountEntity } from '../entities/account.entity';
import { OrganizationEntity } from '../entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountService } from '../account.service';
import { OrganizationInvitationEventsProducer } from 'src/kafka/organization-invitation.producer';
import { OrganizationMemberEventsProducer } from 'src/kafka/organization-member.producer';
import { INVITATION_STATUS_ENUM } from '../enums/invitation-status.enum';

import { GetOrganizationInvitationPreviewUseCase } from './get-organization-invitation-preview.use-case';
import { AcceptOrganizationInvitationUseCase } from './accept-organization-invitation.use-case';

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

/**
 * Los casos de uso se montan sobre el `OrganizationInvitationService` real con repositorios
 * simulados: la expiración perezosa, el rechazo de invitaciones ya usadas y el alta de la
 * membresía son la secuencia bajo prueba, y con el servicio simulado no quedaría nada de eso.
 */
describe('casos de uso de invitaciones a organización', () => {
  let getInvitationPreview: GetOrganizationInvitationPreviewUseCase;
  let acceptInvitation: AcceptOrganizationInvitationUseCase;
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
        GetOrganizationInvitationPreviewUseCase,
        AcceptOrganizationInvitationUseCase,
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

    getInvitationPreview = module.get(GetOrganizationInvitationPreviewUseCase);
    acceptInvitation = module.get(AcceptOrganizationInvitationUseCase);
  });

  describe('GetOrganizationInvitationPreviewUseCase', () => {
    it('lanza NotFoundException si el token no existe', async () => {
      invitationRepository.findOne.mockResolvedValue(null);

      await expect(getInvitationPreview.execute('bad-token')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('retorna el preview de una invitación vigente', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());

      const result = await getInvitationPreview.execute('token-1');

      expect(result.data).toEqual({
        organizationId: 'org-1',
        organizationName: 'Acme Corp',
        email: 'nuevo@empresa.com',
        status: INVITATION_STATUS_ENUM.PENDING,
      });
    });

    it('marca EXPIRED (lazy) una invitación PENDING cuya expiresAt ya pasó', async () => {
      invitationRepository.findOne.mockResolvedValue(
        pendingInvitation({ expiresAt: new Date(Date.now() - 1000) }),
      );

      const result = await getInvitationPreview.execute('token-1');

      expect(result.data.status).toBe(INVITATION_STATUS_ENUM.EXPIRED);
      expect(invitationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: INVITATION_STATUS_ENUM.EXPIRED }),
      );
    });
  });

  describe('AcceptOrganizationInvitationUseCase', () => {
    it('lanza ConflictException si la invitación ya fue aceptada', async () => {
      invitationRepository.findOne.mockResolvedValue(
        pendingInvitation({ status: INVITATION_STATUS_ENUM.ACCEPTED }),
      );

      await expect(
        acceptInvitation.execute('token-1', 'RFC123456789'),
      ).rejects.toThrow(ConflictException);
    });

    it('lanza GoneException si la invitación ya expiró', async () => {
      invitationRepository.findOne.mockResolvedValue(
        pendingInvitation({
          status: INVITATION_STATUS_ENUM.EXPIRED,
          expiresAt: new Date(Date.now() - 1000),
        }),
      );

      await expect(
        acceptInvitation.execute('token-1', 'RFC123456789'),
      ).rejects.toThrow(GoneException);
    });

    it('lanza NotFoundException si el RFC no corresponde a ningún usuario', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        acceptInvitation.execute('token-1', 'RFC123456789'),
      ).rejects.toThrow(NotFoundException);
    });

    it('lanza ConflictException si el usuario ya es miembro activo de la organización', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'user@empresa.com',
        password: 'hashed-pw',
      });
      accountRepository.findOne.mockResolvedValue({ id: 'existing-account' });

      await expect(
        acceptInvitation.execute('token-1', 'RFC123456789'),
      ).rejects.toThrow(ConflictException);
      expect(accountRepository.save).not.toHaveBeenCalled();
      expect(memberEventsProducer.enqueueJoined).not.toHaveBeenCalled();
    });

    /**
     * El aviso a propietarios y administradores se registra en la MISMA transacción que la
     * membresía y la invitación: una incorporación que no llega a confirmarse no debe anunciarse.
     * El actor es el propio invitado, que es quien aceptó; quien lo invitó ya quedó registrado en
     * la invitación.
     */
    it('registra el aviso de incorporación dentro de la transacción y lo publica al confirmar', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'user@empresa.com',
        password: 'hashed-pw',
      });
      accountRepository.findOne.mockResolvedValue(null);

      await acceptInvitation.execute('token-1', 'RFC123456789');

      expect(memberEventsProducer.enqueueJoined).toHaveBeenCalledWith(
        expect.anything(),
        {
          membership: expect.objectContaining({
            userId: 'user-1',
            organizationId: 'org-1',
          }),
          actorUserId: 'user-1',
        },
      );
      expect(memberEventsProducer.flushOutbox).toHaveBeenCalled();
    });

    it('no anuncia ninguna incorporación si la invitación ya había expirado', async () => {
      invitationRepository.findOne.mockResolvedValue(
        pendingInvitation({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        acceptInvitation.execute('token-1', 'RFC123456789'),
      ).rejects.toThrow(GoneException);
      expect(memberEventsProducer.enqueueJoined).not.toHaveBeenCalled();
    });

    it('crea la membresía, marca la invitación ACCEPTED y refresca el catálogo de Redis', async () => {
      const invitation = pendingInvitation();
      invitationRepository.findOne.mockResolvedValue(invitation);
      const user = {
        id: 'user-1',
        email: 'user@empresa.com',
        password: 'hashed-pw',
      };
      userRepository.findOne.mockResolvedValue(user);
      accountRepository.findOne.mockResolvedValue(null); // sin membresía previa

      await acceptInvitation.execute('token-1', 'rfc123456789');

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { personalInformation: { rfc: 'RFC123456789' } },
        relations: { personalInformation: true },
      });
      expect(accountRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          organizationId: 'org-1',
          roleId: 'role-1',
          email: 'user@empresa.com',
          password: 'hashed-pw',
          isActive: true,
        }),
      );
      expect(invitationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: INVITATION_STATUS_ENUM.ACCEPTED }),
      );
      expect(accountService.appendAccountToCatalog).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ userId: 'user-1' }),
      );
    });
  });
});
