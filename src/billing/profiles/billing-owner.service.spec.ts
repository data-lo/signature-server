import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { AccountEntity } from 'src/account/entities/account.entity';
import { ACCOUNT_TYPE_ENUM } from 'src/account/enums/account-type.enum';
import { BillingOwnerService } from './billing-owner.service';
import { BillingProfileEntity } from './billing-profile.entity';
import {
  InconsistentOrganizationAccountException,
  MissingActiveAccountException,
} from '../exceptions/billing.exceptions';

const PERSONAL_ACCOUNT = {
  id: 'account-personal-1',
  accountType: ACCOUNT_TYPE_ENUM.PERSONAL,
  organizationId: null,
};

const ORGANIZATION_ACCOUNT = {
  id: 'account-member-1',
  accountType: ACCOUNT_TYPE_ENUM.ORGANIZATION,
  organizationId: 'organization-1',
};

describe('BillingOwnerService', () => {
  let service: BillingOwnerService;
  let billingProfileRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let accountRepository: { findOne: jest.Mock };

  beforeEach(async () => {
    billingProfileRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'profile-1', ...data })),
    };
    accountRepository = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingOwnerService,
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfileRepository,
        },
        {
          provide: getRepositoryToken(AccountEntity),
          useValue: accountRepository,
        },
      ],
    }).compile();

    service = module.get(BillingOwnerService);
  });

  describe('resolución del propietario facturable', () => {
    it('CA01 — una cuenta personal factura contra su propia fila (personal_account_id)', async () => {
      accountRepository.findOne.mockResolvedValue(
        PERSONAL_ACCOUNT,
      );

      const owner = await service.resolveOwner('user-1', PERSONAL_ACCOUNT.id);

      expect(owner).toEqual({
        personalAccountId: 'account-personal-1',
        organizationId: null,
      });
    });

    /**
     * El punto de la historia: se factura a la ORGANIZACIÓN, no a la fila de membresía del
     * empleado. Si se usara `account.id` (que es lo que trae el header), cada miembro tendría su
     * propio perfil y su propio saldo.
     */
    it('CA02 — una cuenta de organización factura contra la organización, no contra la membresía', async () => {
      accountRepository.findOne.mockResolvedValue(
        ORGANIZATION_ACCOUNT,
      );

      const owner = await service.resolveOwner(
        'user-1',
        ORGANIZATION_ACCOUNT.id,
      );

      expect(owner).toEqual({
        personalAccountId: null,
        organizationId: 'organization-1',
      });
      expect(owner.personalAccountId).not.toBe(ORGANIZATION_ACCOUNT.id);
    });

    it('exige el header X-Account-Id en vez de adivinar la cuenta', async () => {
      await expect(service.resolveOwner('user-1', '')).rejects.toThrow(
        MissingActiveAccountException,
      );
      expect(accountRepository.findOne).not.toHaveBeenCalled();
    });

    it('verifica que el usuario pertenezca de verdad a la cuenta activa', async () => {
      await service
        .resolveOwner('user-1', 'account-ajena')
        .catch(() => undefined);

      expect(accountRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'account-ajena', userId: 'user-1', isActive: true },
      });
    });

    it('falla ruidosamente ante una cuenta ORGANIZATION sin organization_id', async () => {
      accountRepository.findOne.mockResolvedValue({
        ...ORGANIZATION_ACCOUNT,
        organizationId: null,
      });

      await expect(
        service.resolveOwner('user-1', ORGANIZATION_ACCOUNT.id),
      ).rejects.toThrow(InconsistentOrganizationAccountException);
    });
  });

  describe('perfil de facturación', () => {
    it('reutiliza el perfil existente en vez de crear otro', async () => {
      const existing = { id: 'profile-existente' };
      billingProfileRepository.findOne.mockResolvedValue(existing);

      const profile = await service.getOrCreateProfile({
        personalAccountId: 'account-personal-1',
        organizationId: null,
      });

      expect(profile).toBe(existing);
      expect(billingProfileRepository.save).not.toHaveBeenCalled();
    });

    /**
     * CA03: dos miembros distintos de la misma organización llegan con el mismo
     * `organizationId`, así que la búsqueda es idéntica y obtienen la misma fila — de ahí que
     * compartan suscripción y saldo sin ninguna lógica extra.
     */
    it('CA03 — dos miembros de la misma organización obtienen el mismo perfil', async () => {
      const shared = { id: 'profile-organizacion' };
      billingProfileRepository.findOne.mockResolvedValue(shared);

      const primero = await service.getOrCreateProfile({
        personalAccountId: null,
        organizationId: 'organization-1',
      });
      const segundo = await service.getOrCreateProfile({
        personalAccountId: null,
        organizationId: 'organization-1',
      });

      expect(primero).toBe(shared);
      expect(segundo).toBe(shared);
      expect(billingProfileRepository.findOne).toHaveBeenCalledWith({
        where: { organizationId: 'organization-1' },
      });
    });

    it('crea el perfil la primera vez', async () => {
      billingProfileRepository.findOne.mockResolvedValue(null);

      const profile = await service.getOrCreateProfile({
        personalAccountId: 'account-personal-1',
        organizationId: null,
      });

      expect(billingProfileRepository.save).toHaveBeenCalledWith({
        personalAccountId: 'account-personal-1',
        organizationId: null,
      });
      expect(profile.id).toBe('profile-1');
    });

    /**
     * Dos peticiones simultáneas del mismo propietario (doble clic en "Contratar") pueden pasar
     * las dos por el `findOne` antes de que ninguna inserte. La perdedora choca contra el índice
     * único y debe recuperar el perfil que ganó, no reventarle al usuario.
     */
    it('ante una carrera de inserción devuelve el perfil que ganó, sin propagar el error', async () => {
      const ganador = { id: 'profile-ganador' };
      billingProfileRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(ganador);
      billingProfileRepository.save.mockRejectedValue(
        new QueryFailedError('INSERT', [], new Error('duplicate key')),
      );

      const profile = await service.getOrCreateProfile({
        personalAccountId: null,
        organizationId: 'organization-1',
      });

      expect(profile).toBe(ganador);
    });

    it('propaga el error si la inserción falló por algo que no era una carrera', async () => {
      billingProfileRepository.findOne.mockResolvedValue(null);
      billingProfileRepository.save.mockRejectedValue(
        new QueryFailedError('INSERT', [], new Error('disco lleno')),
      );

      await expect(
        service.getOrCreateProfile({
          personalAccountId: null,
          organizationId: 'organization-1',
        }),
      ).rejects.toThrow(QueryFailedError);
    });
  });
});
