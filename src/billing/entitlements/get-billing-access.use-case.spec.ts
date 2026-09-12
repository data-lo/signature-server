import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull, MoreThan } from 'typeorm';
import { GetBillingAccessUseCase } from './get-billing-access.use-case';
import { PLAN_ENTITLEMENTS } from './plan-entitlements.config';
import { PLAN_ACTION_ENUM, PLAN_LIMIT_ENUM } from './plan-entitlements.types';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { CreditLotEntity } from '../credits/credit-lot.entity';
import { SubscriptionBillingHistoryEntity } from '../subscriptions/subscription-billing-history.entity';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import { BILLING_SOURCE_ENUM } from '../enums/billing-source.enum';
import { MissingActiveAccountException } from '../exceptions/billing.exceptions';

const PERSONAL_OWNER = {
  personalAccountId: 'account-1',
  organizationId: null,
};
const ORGANIZATION_OWNER = {
  personalAccountId: null,
  organizationId: 'org-1',
};

describe('GetBillingAccessUseCase', () => {
  let useCase: GetBillingAccessUseCase;
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    findProfileByOwner: jest.Mock;
    getOrCreateProfile: jest.Mock;
  };
  let creditLotRepository: { sum: jest.Mock };
  let billingHistoryRepository: { findOne: jest.Mock };

  beforeEach(async () => {
    billingOwnerService = {
      resolveOwner: jest.fn().mockResolvedValue(PERSONAL_OWNER),
      findProfileByOwner: jest.fn().mockResolvedValue(null),
      getOrCreateProfile: jest.fn(),
    };
    creditLotRepository = { sum: jest.fn().mockResolvedValue(null) };
    billingHistoryRepository = { findOne: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetBillingAccessUseCase,
        { provide: BillingOwnerService, useValue: billingOwnerService },
        {
          provide: getRepositoryToken(CreditLotEntity),
          useValue: creditLotRepository,
        },
        {
          provide: getRepositoryToken(SubscriptionBillingHistoryEntity),
          useValue: billingHistoryRepository,
        },
      ],
    }).compile();

    useCase = module.get(GetBillingAccessUseCase);
  });

  const execute = (accountId = 'account-1') =>
    useCase.execute({ userId: 'user-1', accountId });

  const perfil = (
    overrides: Partial<{
      id: string;
      status: BILLING_PROFILE_STATUS_ENUM;
      currentPlanType: string | null;
      cancelAtPeriodEnd: boolean;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
    }> = {},
  ) =>
    billingOwnerService.findProfileByOwner.mockResolvedValue({
      id: 'profile-1',
      status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
      currentPlanType: 'plus',
      cancelAtPeriodEnd: false,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      ...overrides,
    });

  describe('quién paga', () => {
    /**
     * El propietario no se deduce acá: sale de `resolveOwner`, que además comprueba la
     * membresía. Es lo que impide leer el plan, el saldo y los beneficios de una cuenta ajena
     * cambiando el header.
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
     * membresía daría un saldo por empleado en vez del único que comparte la organización.
     */
    it('consulta por la organización cuando el propietario es una organización', async () => {
      billingOwnerService.resolveOwner.mockResolvedValue(ORGANIZATION_OWNER);
      perfil({ currentPlanType: 'premium' });

      const respuesta = await execute('account-org');

      expect(billingOwnerService.findProfileByOwner).toHaveBeenCalledWith(
        ORGANIZATION_OWNER,
      );
      expect(respuesta.currentPlanType).toBe('premium');
    });

    it('propaga el 403 de una cuenta que no es del usuario sin consultar el perfil', async () => {
      billingOwnerService.resolveOwner.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(execute('cuenta-ajena')).rejects.toThrow(ForbiddenException);
      expect(billingOwnerService.findProfileByOwner).not.toHaveBeenCalled();
      expect(creditLotRepository.sum).not.toHaveBeenCalled();
    });

    it('propaga el 400 si no llegó la cuenta activa', async () => {
      billingOwnerService.resolveOwner.mockRejectedValue(
        new MissingActiveAccountException(),
      );

      await expect(execute('')).rejects.toThrow(MissingActiveAccountException);
    });
  });

  describe('perfil inexistente', () => {
    it('devuelve un estado Free seguro a una cuenta personal en vez de fallar', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      await expect(execute()).resolves.toEqual({
        billingProfileId: null,
        hasActiveSubscription: false,
        currentPlanType: null,
        status: null,
        billingSource: null,
        cancelAtPeriodEnd: false,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        creditsAvailable: 0,
        actions: PLAN_ENTITLEMENTS.free.actions,
        limits: PLAN_ENTITLEMENTS.free.limits,
      });
    });

    /** Sin perfil no hay saldo ni historial que consultar: son dos consultas que sobran. */
    it('no consulta créditos ni historial cuando no hay perfil', async () => {
      await execute();

      expect(creditLotRepository.sum).not.toHaveBeenCalled();
      expect(billingHistoryRepository.findOne).not.toHaveBeenCalled();
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

  /**
   * Las organizaciones nacen sin perfil ni plan Free: hasta contratar una suscripción no pueden
   * hacer nada, y la respuesta no las presenta como gratuitas.
   */
  describe('organización sin plan', () => {
    const NO_ACTIONS = Object.fromEntries(
      Object.values(PLAN_ACTION_ENUM).map((action) => [action, false]),
    );

    beforeEach(() => {
      billingOwnerService.resolveOwner.mockResolvedValue(ORGANIZATION_OWNER);
    });

    it('responde sin plan, sin créditos y con todas las acciones deshabilitadas si no tiene perfil', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      await expect(execute('org-account-1')).resolves.toEqual({
        billingProfileId: null,
        hasActiveSubscription: false,
        currentPlanType: null,
        status: null,
        billingSource: null,
        cancelAtPeriodEnd: false,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        creditsAvailable: 0,
        actions: NO_ACTIONS,
        limits: {
          [PLAN_LIMIT_ENUM.DOCUMENTS_INCLUDED_PER_PERIOD]: null,
          [PLAN_LIMIT_ENUM.MAX_ORGANIZATION_MEMBERS]: null,
        },
      });
    });

    it('no la trata como Free ni le crea el perfil', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      const access = await execute('org-account-1');

      expect(access.currentPlanType).toBeNull();
      expect(access.actions).not.toEqual(PLAN_ENTITLEMENTS.free.actions);
      expect(billingOwnerService.getOrCreateProfile).not.toHaveBeenCalled();
    });

    /** El perfil que abre un Checkout de suscripción nace sin plan hasta que el pago se confirma. */
    it('tampoco la trata como Free si su perfil se abrió en un Checkout que nunca se pagó', async () => {
      perfil({
        currentPlanType: null,
        status: BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      });

      await expect(execute('org-account-1')).resolves.toMatchObject({
        billingProfileId: 'profile-1',
        hasActiveSubscription: false,
        currentPlanType: null,
        actions: NO_ACTIONS,
      });
    });

    it('una organización con plan contratado conserva sus beneficios', async () => {
      perfil({ currentPlanType: 'plus' });

      await expect(execute('org-account-1')).resolves.toMatchObject({
        hasActiveSubscription: true,
        actions: PLAN_ENTITLEMENTS.plus.actions,
      });
    });

    /** Las organizaciones que ya existían nacieron con perfil Free y no cambian. */
    it('una organización Free existente conserva el plan gratuito', async () => {
      perfil({
        currentPlanType: 'free',
        status: BILLING_PROFILE_STATUS_ENUM.FREE,
      });

      await expect(execute('org-account-1')).resolves.toMatchObject({
        currentPlanType: 'free',
        actions: PLAN_ENTITLEMENTS.free.actions,
      });
    });
  });

  describe('estado del perfil', () => {
    it('devuelve el perfil completo, con su periodo y su baja programada', async () => {
      const inicio = new Date('2026-09-04T00:00:00.000Z');
      const fin = new Date('2026-10-04T00:00:00.000Z');
      perfil({
        currentPlanType: 'premium',
        cancelAtPeriodEnd: true,
        currentPeriodStart: inicio,
        currentPeriodEnd: fin,
      });

      await expect(execute()).resolves.toMatchObject({
        billingProfileId: 'profile-1',
        hasActiveSubscription: true,
        currentPlanType: 'premium',
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        cancelAtPeriodEnd: true,
        currentPeriodStart: inicio,
        currentPeriodEnd: fin,
      });
    });

    /**
     * El plan se conserva en los estados no vigentes —sigue siendo el último contratado y la
     * pantalla necesita nombrarlo—; lo único que cambia es que no habilita el servicio.
     */
    it.each([
      BILLING_PROFILE_STATUS_ENUM.FREE,
      BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])('no marca hasActiveSubscription con el perfil %s', async (status) => {
      perfil({ status });

      await expect(execute()).resolves.toMatchObject({
        hasActiveSubscription: false,
        currentPlanType: 'plus',
      });
    });

    /**
     * Un cobro que falló no le quita al cliente lo que compró: Stripe todavía lo está
     * reintentando, y cortar el producto sería una decisión comercial que nadie tomó.
     */
    it('conserva los beneficios del plan aunque la suscripción no esté vigente', async () => {
      perfil({
        status: BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
        currentPlanType: 'premium',
      });

      const respuesta = await execute();

      expect(respuesta.hasActiveSubscription).toBe(false);
      expect(respuesta.actions).toEqual(PLAN_ENTITLEMENTS.premium.actions);
    });
  });

  describe('beneficios por plan', () => {
    it.each([
      ['free', PLAN_ENTITLEMENTS.free],
      ['plus', PLAN_ENTITLEMENTS.plus],
      ['premium', PLAN_ENTITLEMENTS.premium],
      ['enterprise', PLAN_ENTITLEMENTS.enterprise],
      ['partners', PLAN_ENTITLEMENTS.partners],
    ])(
      'resuelve las acciones y los límites de %s',
      async (planType, esperado) => {
        perfil({ currentPlanType: planType });

        await expect(execute()).resolves.toMatchObject({
          actions: esperado.actions,
          limits: esperado.limits,
        });
      },
    );

    /** Un ejemplo concreto por si el mapa se toca sin querer: premium no tiene branding. */
    it('marca las acciones que el plan NO incluye', async () => {
      perfil({ currentPlanType: 'premium' });

      const { actions, limits } = await execute();

      expect(actions[PLAN_ACTION_ENUM.PRE_APPROVAL]).toBe(true);
      expect(actions[PLAN_ACTION_ENUM.CUSTOM_BRANDING]).toBe(false);
      expect(actions[PLAN_ACTION_ENUM.API_INTEGRATION]).toBe(false);
      expect(limits[PLAN_LIMIT_ENUM.DOCUMENTS_INCLUDED_PER_PERIOD]).toBe(60);
      expect(limits[PLAN_LIMIT_ENUM.MAX_ORGANIZATION_MEMBERS]).toBeNull();
    });

    /**
     * `plans.plan_type` se alimenta de Stripe, así que un plan que este mapa no conoce entra sin
     * que nadie despliegue. Se responde Free —lo mínimo— en vez de reventar la pantalla entera o,
     * peor, regalar lo que no consta como vendido.
     */
    it('cae al plan gratuito con un plan que no está en el mapa', async () => {
      perfil({ currentPlanType: 'basic' });

      await expect(execute()).resolves.toMatchObject({
        currentPlanType: 'basic',
        actions: PLAN_ENTITLEMENTS.free.actions,
      });
    });

    it('cae al plan gratuito con un perfil sin plan', async () => {
      perfil({ currentPlanType: null });

      await expect(execute()).resolves.toMatchObject({
        actions: PLAN_ENTITLEMENTS.free.actions,
      });
    });
  });

  describe('saldo de documentos', () => {
    it('suma el saldo utilizable del perfil', async () => {
      perfil();
      creditLotRepository.sum.mockResolvedValue(18);

      await expect(execute()).resolves.toMatchObject({
        creditsAvailable: 18,
      });
    });

    /**
     * Las dos condiciones van en OR porque en SQL `NULL > NOW()` no es verdadero: con un solo
     * `where` se perderían justo los lotes que no caducan, que son la mayoría.
     */
    it('cuenta los lotes sin gastar que no han caducado, con o sin fecha de caducidad', async () => {
      perfil();

      await execute();

      expect(creditLotRepository.sum).toHaveBeenCalledWith('remaining', [
        {
          billingProfileId: 'profile-1',
          remaining: MoreThan(0),
          expiresAt: IsNull(),
        },
        {
          billingProfileId: 'profile-1',
          remaining: MoreThan(0),
          expiresAt: MoreThan(expect.any(Date)),
        },
      ]);
    });

    /** Sin lotes, `SUM` vuelve nulo; para el consumidor eso es no tener saldo. */
    it('devuelve 0 cuando no hay ningún lote', async () => {
      perfil();
      creditLotRepository.sum.mockResolvedValue(null);

      await expect(execute()).resolves.toMatchObject({ creditsAvailable: 0 });
    });
  });

  describe('origen del cobro', () => {
    it('devuelve el origen del último periodo facturado', async () => {
      perfil();
      billingHistoryRepository.findOne.mockResolvedValue({
        id: 'historia-1',
        source: BILLING_SOURCE_ENUM.MANUAL,
      });

      await expect(execute()).resolves.toMatchObject({
        billingSource: BILLING_SOURCE_ENUM.MANUAL,
      });
    });

    /** El periodo más reciente, no el cobro más reciente: una transferencia se captura tarde. */
    it('busca el periodo más reciente del perfil', async () => {
      perfil();

      await execute();

      expect(billingHistoryRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { billingProfileId: 'profile-1' },
          order: { periodStart: 'DESC' },
        }),
      );
    });

    /** Una cuenta gratuita nunca fue cobrada: no es "se desconoce", es que no lo cobró nadie. */
    it('devuelve null cuando el perfil no tiene ningún periodo facturado', async () => {
      perfil({ status: BILLING_PROFILE_STATUS_ENUM.FREE });
      billingHistoryRepository.findOne.mockResolvedValue(null);

      await expect(execute()).resolves.toMatchObject({ billingSource: null });
    });
  });
});
