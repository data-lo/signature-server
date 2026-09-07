import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BillingOwnerService } from 'src/billing/profiles/billing-owner.service';
import { BILLING_PROFILE_STATUS_ENUM } from 'src/billing/enums/billing-profile-status.enum';
import { MissingActiveAccountException } from 'src/billing/exceptions/billing.exceptions';
import { GetSubscriptionStateUseCase } from './get-subscription-state.use-case';

const PERSONAL_OWNER = {
  personalAccountId: 'cuenta-personal-1',
  organizationId: null,
};
const ORGANIZATION_OWNER = {
  personalAccountId: null,
  organizationId: 'organizacion-1',
};

const PERIODO_INICIO = new Date('2030-01-01T00:00:00.000Z');
const PERIODO_FIN = new Date('2030-02-01T00:00:00.000Z');

describe('GetSubscriptionStateUseCase', () => {
  let useCase: GetSubscriptionStateUseCase;
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    findProfileByOwner: jest.Mock;
    getOrCreateProfile: jest.Mock;
  };

  beforeEach(async () => {
    billingOwnerService = {
      resolveOwner: jest.fn().mockResolvedValue(PERSONAL_OWNER),
      findProfileByOwner: jest.fn().mockResolvedValue(null),
      getOrCreateProfile: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetSubscriptionStateUseCase,
        { provide: BillingOwnerService, useValue: billingOwnerService },
      ],
    }).compile();

    useCase = module.get(GetSubscriptionStateUseCase);
  });

  const execute = (accountId = 'cuenta-personal-1') =>
    useCase.execute({ userId: 'usuario-1', accountId });

  const perfil = (
    status: BILLING_PROFILE_STATUS_ENUM,
    extra: Record<string, unknown> = {},
  ) =>
    billingOwnerService.findProfileByOwner.mockResolvedValue({
      id: 'perfil-1',
      status,
      currentPlanType: 'plus',
      currentPeriodStart: PERIODO_INICIO,
      currentPeriodEnd: PERIODO_FIN,
      ...extra,
    });

  describe('cuenta personal', () => {
    it('resuelve el propietario con el usuario y la cuenta activa', async () => {
      await execute('cuenta-7');

      expect(billingOwnerService.resolveOwner).toHaveBeenCalledWith(
        'usuario-1',
        'cuenta-7',
      );
    });

    it('consulta el perfil por personal_account_id', async () => {
      await execute();

      expect(billingOwnerService.findProfileByOwner).toHaveBeenCalledWith(
        PERSONAL_OWNER,
      );
    });
  });

  describe('organización', () => {
    /**
     * El perfil de una organización es uno solo y compartido: consultar por la membresía daría
     * un estado por empleado en vez del único que comparte la organización.
     */
    it('consulta el perfil por organization_id y devuelve su suscripción', async () => {
      billingOwnerService.resolveOwner.mockResolvedValue(ORGANIZATION_OWNER);
      perfil(BILLING_PROFILE_STATUS_ENUM.ACTIVE, {
        currentPlanType: 'premium',
      });

      await expect(execute('cuenta-org')).resolves.toEqual({
        hasActiveSubscription: true,
        planType: 'premium',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPeriodStart: PERIODO_INICIO,
        currentPeriodEnd: PERIODO_FIN,
      });
      expect(billingOwnerService.findProfileByOwner).toHaveBeenCalledWith(
        ORGANIZATION_OWNER,
      );
    });
  });

  describe('perfil inexistente', () => {
    it('devuelve el estado sin suscripción en vez de fallar', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      await expect(execute()).resolves.toEqual({
        hasActiveSubscription: false,
        planType: null,
        status: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      });
    });

    /**
     * Antes esto lanzaba `NotFoundException` cuando el usuario no tenía ninguna cuenta activa.
     * Consultar el estado no puede dar de alta nada ni fallar por no haber contratado: la
     * pantalla necesita poder pintar "sin suscripción" sin distinguir un 404 de un estado vacío.
     */
    it('no crea el perfil al consultarlo', async () => {
      await execute();

      expect(billingOwnerService.getOrCreateProfile).not.toHaveBeenCalled();
    });
  });

  describe('perfil ACTIVE', () => {
    /**
     * El caso que motiva el cambio: `invoice.paid` deja el perfil en ACTIVE, y hasta ahora la
     * pantalla seguía diciendo "inactiva" porque leía `account_subscriptions`, que el webhook
     * mantiene por compatibilidad pero no refleja la activación.
     */
    it('reporta la suscripción como activa, con su plan y su periodo', async () => {
      perfil(BILLING_PROFILE_STATUS_ENUM.ACTIVE);

      await expect(execute()).resolves.toEqual({
        hasActiveSubscription: true,
        planType: 'plus',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        currentPeriodStart: PERIODO_INICIO,
        currentPeriodEnd: PERIODO_FIN,
      });
    });
  });

  describe('estados que no habilitan', () => {
    /**
     * El estado más común: toda cuenta nace con su perfil en plan gratuito. Conserva su
     * `planType` y su `status`, pero no es una suscripción de pago.
     */
    it('el plan gratuito no cuenta como suscripción activa', async () => {
      perfil(BILLING_PROFILE_STATUS_ENUM.FREE, { currentPlanType: 'free' });

      await expect(execute()).resolves.toMatchObject({
        hasActiveSubscription: false,
        planType: 'free',
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
      });
    });

    it.each([
      BILLING_PROFILE_STATUS_ENUM.FREE,
      BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])('%s no cuenta como suscripción activa', async (status) => {
      perfil(status);

      const estado = await execute();

      expect(estado.hasActiveSubscription).toBe(false);
      // El plan se conserva: sigue siendo del que se habla, sólo que no está vigente.
      expect(estado.planType).toBe('plus');
      expect(estado.status).toBe(status);
    });
  });

  describe('quién consulta', () => {
    it('propaga el 403 de una cuenta ajena sin consultar el perfil', async () => {
      billingOwnerService.resolveOwner.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(execute('cuenta-ajena')).rejects.toThrow(ForbiddenException);
      expect(billingOwnerService.findProfileByOwner).not.toHaveBeenCalled();
    });

    it('propaga el 400 si no llegó la cuenta activa', async () => {
      billingOwnerService.resolveOwner.mockRejectedValue(
        new MissingActiveAccountException(),
      );

      await expect(execute('')).rejects.toThrow(MissingActiveAccountException);
    });
  });
});
