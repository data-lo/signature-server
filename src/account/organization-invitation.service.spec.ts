import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OrganizationInvitationService } from './organization-invitation.service';
import { OrganizationInvitationEntity } from './entities/organization-invitation.entity';
import { AccountEntity } from './entities/account.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { UserEntity } from 'src/user/entities/user.entity';
import { AccountService } from './account.service';
import { OrganizationInvitationEventsProducer } from 'src/kafka/organization-invitation.producer';
import { INVITATION_STATUS_ENUM } from './enums/invitation-status.enum';

function createMockRepository() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 'saved-id', ...data })),
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

  beforeEach(async () => {
    invitationRepository = createMockRepository();
    accountRepository = createMockRepository();
    organizationRepository = createMockRepository();
    userRepository = createMockRepository();
    accountService = { appendAccountToCatalog: jest.fn() };
    invitationEventsProducer = { emitInvited: jest.fn() };

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

  describe('getPreview', () => {
    it('lanza NotFoundException si el token no existe', async () => {
      invitationRepository.findOne.mockResolvedValue(null);

      await expect(service.getPreview('bad-token')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('retorna el preview de una invitación vigente', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());

      const result = await service.getPreview('token-1');

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

      const result = await service.getPreview('token-1');

      expect(result.data.status).toBe(INVITATION_STATUS_ENUM.EXPIRED);
      expect(invitationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: INVITATION_STATUS_ENUM.EXPIRED }),
      );
    });
  });

  describe('acceptByRfc', () => {
    it('lanza ConflictException si la invitación ya fue aceptada', async () => {
      invitationRepository.findOne.mockResolvedValue(
        pendingInvitation({ status: INVITATION_STATUS_ENUM.ACCEPTED }),
      );

      await expect(
        service.acceptByRfc('token-1', 'RFC123456789'),
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
        service.acceptByRfc('token-1', 'RFC123456789'),
      ).rejects.toThrow(GoneException);
    });

    it('lanza NotFoundException si el RFC no corresponde a ningún usuario', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.acceptByRfc('token-1', 'RFC123456789'),
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
        service.acceptByRfc('token-1', 'RFC123456789'),
      ).rejects.toThrow(ConflictException);
      expect(accountRepository.save).not.toHaveBeenCalled();
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

      await service.acceptByRfc('token-1', 'rfc123456789');

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

  describe('acceptForUser', () => {
    it('lanza NotFoundException si el usuario no existe', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.acceptForUser('token-1', 'missing-user'),
      ).rejects.toThrow(NotFoundException);
    });

    it('crea la membresía para el usuario recién registrado', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation());
      userRepository.findOne.mockResolvedValue({
        id: 'user-2',
        email: 'nuevo-registro@empresa.com',
        password: 'hashed-pw-2',
      });
      accountRepository.findOne.mockResolvedValue(null);

      await service.acceptForUser('token-1', 'user-2');

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'user-2' },
      });
      expect(accountRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-2', organizationId: 'org-1' }),
      );
    });
  });
});
