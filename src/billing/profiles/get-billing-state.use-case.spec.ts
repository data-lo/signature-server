import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GetBillingStateUseCase } from './get-billing-state.use-case';
import { BillingOwnerService } from './billing-owner.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { MissingActiveAccountException } from '../exceptions/billing.exceptions';

const PERSONAL_OWNER = {
  personalAccountId: 'account-1',
  organizationId: null,
};
const ORGANIZATION_OWNER = {
  personalAccountId: null,
  organizationId: 'org-1',
};

describe('GetBillingStateUseCase', () => {
  let useCase: GetBillingStateUseCase;
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
        GetBillingStateUseCase,
        { provide: BillingOwnerService, useValue: billingOwnerService },
      ],
    }).compile();

    useCase = module.get(GetBillingStateUseCase);
  });

  const execute = (accountId = 'account-1') =>
    useCase.execute({ userId: 'user-1', accountId });

  const perfil = (status: BILLING_PROFILE_STATUS_ENUM, planType = 'plus') =>
    billingOwnerService.findProfileByOwner.mockResolvedValue({
      id: 'profile-1',
      status,
      currentPlanType: planType,
    });

  describe('quién paga', () => {
    /**
     * El propietario no se deduce acá: sale de `resolveOwner`, que además comprueba la
     * membresía. Es lo que impide leer el plan de una organización ajena cambiando el header.
     */
    it('resuelve el propietario a partir del usuario y la cuenta activa', async () => {
      await execute('account-7');

      expect(billingOwnerService.resolveOwner).toHaveBeenCalledWith(
        'user-1',
        'account-7',
      );
    });

    it('consulta por la cuenta personal cuando el propietario es personal', async () => {
      await execute();

      expect(billingOwnerService.findProfileByOwner).toHaveBeenCalledWith(
        PERSONAL_OWNER,
      );
    });

    /**
     * El perfil de una organización es uno solo y compartido por sus miembros: consultar por la
     * membresía daría un estado por empleado en vez del único que comparte la organización.
     */
    it('consulta por la organización cuando el propietario es una organización', async () => {
      billingOwnerService.resolveOwner.mockResolvedValue(ORGANIZATION_OWNER);
      perfil(BILLING_PROFILE_STATUS_ENUM.ACTIVE, 'premium');

      await expect(execute('account-org')).resolves.toEqual({
        billingProfileId: 'profile-1',
        hasActiveSubscription: true,
        currentPlanType: 'premium',
      });
      expect(billingOwnerService.findProfileByOwner).toHaveBeenCalledWith(
        ORGANIZATION_OWNER,
      );
    });

    it('propaga el 403 de una cuenta que no es del usuario sin consultar el perfil', async () => {
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

  describe('perfil inexistente', () => {
    it('devuelve el estado vacío en vez de fallar', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      await expect(execute()).resolves.toEqual({
        billingProfileId: null,
        hasActiveSubscription: false,
        currentPlanType: null,
      });
    });

    /**
     * Una consulta de lectura no da de alta nada: si creara el perfil, cada cuenta que sólo
     * abrió la pantalla dejaría una fila en `billing_profiles` y el caso "sin perfil" no se
     * volvería a dar nunca.
     */
    it('no crea el perfil', async () => {
      await execute();

      expect(billingOwnerService.getOrCreateProfile).not.toHaveBeenCalled();
    });
  });

  describe('estado del perfil', () => {
    it('marca hasActiveSubscription cuando el perfil está ACTIVE', async () => {
      perfil(BILLING_PROFILE_STATUS_ENUM.ACTIVE, 'basic');

      await expect(execute()).resolves.toEqual({
        billingProfileId: 'profile-1',
        hasActiveSubscription: true,
        currentPlanType: 'basic',
      });
    });

    /**
     * El plan se conserva en los tres estados no vigentes —sigue siendo el último contratado y
     * la pantalla necesita nombrarlo—; lo único que cambia es que no habilita el servicio.
     */
    it.each([
      BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])('no marca hasActiveSubscription con el perfil %s', async (status) => {
      perfil(status, 'plus');

      await expect(execute()).resolves.toEqual({
        billingProfileId: 'profile-1',
        hasActiveSubscription: false,
        currentPlanType: 'plus',
      });
    });

    it('devuelve currentPlanType nulo si el perfil todavía no tiene plan', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue({
        id: 'profile-1',
        status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
        currentPlanType: null,
      });

      await expect(execute()).resolves.toEqual({
        billingProfileId: 'profile-1',
        hasActiveSubscription: false,
        currentPlanType: null,
      });
    });
  });
});
