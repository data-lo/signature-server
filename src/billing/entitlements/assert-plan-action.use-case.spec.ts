import { ForbiddenException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AssertPlanActionUseCase } from './assert-plan-action.use-case';
import { GetBillingAccessUseCase } from './get-billing-access.use-case';
import { PLAN_ENTITLEMENTS } from './plan-entitlements.config';
import {
  PLAN_ACTION_ENUM,
  type BillingAccessResponse,
} from './plan-entitlements.types';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import {
  InsufficientDocumentCreditsException,
  PlanActionNotIncludedException,
} from '../exceptions/billing.exceptions';

function accesoCon(
  planType: keyof typeof PLAN_ENTITLEMENTS,
  creditsAvailable: number,
): BillingAccessResponse {
  const { actions, limits } = PLAN_ENTITLEMENTS[planType];

  return {
    billingProfileId: 'profile-1',
    hasActiveSubscription: true,
    currentPlanType: planType,
    status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
    billingSource: null,
    cancelAtPeriodEnd: false,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    creditsAvailable,
    actions,
    limits,
  };
}

describe('AssertPlanActionUseCase', () => {
  let useCase: AssertPlanActionUseCase;
  let getBillingAccess: { execute: jest.Mock };

  beforeEach(async () => {
    getBillingAccess = {
      execute: jest.fn().mockResolvedValue(accesoCon('premium', 5)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssertPlanActionUseCase,
        { provide: GetBillingAccessUseCase, useValue: getBillingAccess },
      ],
    }).compile();

    useCase = module.get(AssertPlanActionUseCase);
  });

  const assert = (action: PLAN_ACTION_ENUM, requiredCredits?: number) =>
    useCase.execute({
      userId: 'user-1',
      accountId: 'account-1',
      action,
      requiredCredits,
    });

  describe('la acción del plan', () => {
    it('deja pasar lo que el plan incluye', async () => {
      await expect(
        assert(PLAN_ACTION_ENUM.PRE_APPROVAL),
      ).resolves.toMatchObject({ currentPlanType: 'premium' });
    });

    /**
     * 403 y no 402: a quien le falta el beneficio hay que mandarlo a mejorar de plan, y comprar
     * documentos no le desbloquearía nada.
     */
    it('rechaza con 403 lo que el plan no incluye', async () => {
      await expect(assert(PLAN_ACTION_ENUM.CUSTOM_BRANDING)).rejects.toThrow(
        PlanActionNotIncludedException,
      );
      await expect(assert(PLAN_ACTION_ENUM.CUSTOM_BRANDING)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it.each([
      ['free', PLAN_ACTION_ENUM.BULK_SIGNING],
      ['plus', PLAN_ACTION_ENUM.PRE_APPROVAL],
      ['premium', PLAN_ACTION_ENUM.API_INTEGRATION],
    ] as const)(
      'rechaza %s cuando pide una acción que no tiene',
      async (planType, action) => {
        getBillingAccess.execute.mockResolvedValue(accesoCon(planType, 10));

        await expect(assert(action)).rejects.toThrow(
          PlanActionNotIncludedException,
        );
      },
    );

    it.each([
      ['enterprise', PLAN_ACTION_ENUM.CUSTOM_BRANDING],
      ['partners', PLAN_ACTION_ENUM.CASE_FILE_GROUPING],
    ] as const)('deja pasar a %s en sus acciones', async (planType, action) => {
      getBillingAccess.execute.mockResolvedValue(accesoCon(planType, 10));

      await expect(assert(action)).resolves.toBeDefined();
    });
  });

  describe('saldo de documentos', () => {
    it('deja pasar cuando alcanza el saldo pedido', async () => {
      await expect(
        assert(PLAN_ACTION_ENUM.SIGN_SIMPLE_AND_ADVANCED, 5),
      ).resolves.toBeDefined();
    });

    /** 402 Payment Required: el plan es el correcto y lo único que falta es recargar. */
    it('rechaza con 402 cuando el saldo no alcanza', async () => {
      getBillingAccess.execute.mockResolvedValue(accesoCon('premium', 0));

      const fallo = await assert(
        PLAN_ACTION_ENUM.SIGN_SIMPLE_AND_ADVANCED,
        1,
      ).catch((error: InsufficientDocumentCreditsException) => error);

      expect(fallo).toBeInstanceOf(InsufficientDocumentCreditsException);
      expect((fallo as InsufficientDocumentCreditsException).getStatus()).toBe(
        HttpStatus.PAYMENT_REQUIRED,
      );
    });

    /** Lo que no gasta saldo no se bloquea por saldo: branding, expedientes, API. */
    it('no mira el saldo cuando la acción no consume documentos', async () => {
      getBillingAccess.execute.mockResolvedValue(accesoCon('enterprise', 0));

      await expect(
        assert(PLAN_ACTION_ENUM.CASE_FILE_GROUPING),
      ).resolves.toBeDefined();
    });

    /**
     * El orden importa para el mensaje: a quien no tiene la funcionalidad se le dice que le falta
     * plan, no que le falten documentos.
     */
    it('avisa primero del plan cuando faltan las dos cosas', async () => {
      getBillingAccess.execute.mockResolvedValue(accesoCon('free', 0));

      await expect(assert(PLAN_ACTION_ENUM.BULK_SIGNING, 1)).rejects.toThrow(
        PlanActionNotIncludedException,
      );
    });
  });

  describe('quién pregunta', () => {
    /**
     * Autoriza contra la cuenta ACTIVA, y por eso resuelve el acceso en vez de recibirlo: el
     * mismo usuario tiene beneficios distintos en su cuenta personal y en su organización, y
     * `GetBillingAccessUseCase` es además quien comprueba que pertenezca a la que dice.
     */
    it('resuelve el acceso de la cuenta activa que se le pasa', async () => {
      await assert(PLAN_ACTION_ENUM.PRE_APPROVAL);

      expect(getBillingAccess.execute).toHaveBeenCalledWith({
        userId: 'user-1',
        accountId: 'account-1',
      });
    });

    it('propaga el 403 de una cuenta que no es del usuario', async () => {
      getBillingAccess.execute.mockRejectedValue(
        new ForbiddenException('No perteneces a esta cuenta'),
      );

      await expect(assert(PLAN_ACTION_ENUM.PRE_APPROVAL)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
