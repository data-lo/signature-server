import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { PaymentGatewayUnavailableException } from 'src/payments/exceptions/payments.exceptions';
import { ResumeSubscriptionUseCase } from './resume-subscription.use-case';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import {
  NoActiveSubscriptionToCancelException,
  NoScheduledCancellationToResumeException,
} from '../exceptions/billing.exceptions';

const PERIOD_END = new Date('2030-02-01T00:00:00.000Z');

/** El punto de partida de este flujo: activa, pero con la baja ya programada. */
function perfilConBajaProgramada(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
    currentPlanType: 'plus',
    stripeSubscriptionId: 'sub_1',
    stripeCustomerId: 'cus_1',
    cancelAtPeriodEnd: true,
    currentPeriodStart: new Date('2030-01-01T00:00:00.000Z'),
    currentPeriodEnd: PERIOD_END,
    ...overrides,
  };
}

describe('ResumeSubscriptionUseCase', () => {
  let useCase: ResumeSubscriptionUseCase;
  let billingProfileRepository: { update: jest.Mock };
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    findProfileByOwner: jest.Mock;
  };
  let paymentGateway: { resumeSubscription: jest.Mock };

  beforeEach(async () => {
    billingProfileRepository = { update: jest.fn() };
    billingOwnerService = {
      resolveOwner: jest
        .fn()
        .mockResolvedValue({ personalAccountId: 'account-1' }),
      findProfileByOwner: jest
        .fn()
        .mockResolvedValue(perfilConBajaProgramada()),
    };
    paymentGateway = {
      resumeSubscription: jest
        .fn()
        .mockResolvedValue({ id: 'sub_1', cancel_at_period_end: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResumeSubscriptionUseCase,
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfileRepository,
        },
        { provide: BillingOwnerService, useValue: billingOwnerService },
        { provide: StripePaymentService, useValue: paymentGateway },
      ],
    }).compile();

    useCase = module.get(ResumeSubscriptionUseCase);
  });

  function reanudar() {
    return useCase.execute({ userId: 'user-1', accountId: 'account-1' });
  }

  describe('reactivación exitosa', () => {
    it('le pide a Stripe que vuelva a renovar la suscripción', async () => {
      await reanudar();

      expect(paymentGateway.resumeSubscription).toHaveBeenCalledWith('sub_1');
    });

    it('quita la marca sin tocar estado, plan ni periodo', async () => {
      await reanudar();

      expect(billingProfileRepository.update).toHaveBeenCalledWith('profile-1', {
        cancelAtPeriodEnd: false,
      });
    });

    it('responde el estado con la renovación restablecida', async () => {
      await expect(reanudar()).resolves.toEqual({
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        planType: 'plus',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: PERIOD_END,
      });
    });

    it('funciona igual para una organización', async () => {
      billingOwnerService.resolveOwner.mockResolvedValue({
        organizationId: 'org-1',
      });
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilConBajaProgramada({ id: 'profile-org' }),
      );

      await reanudar();

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-org',
        { cancelAtPeriodEnd: false },
      );
    });
  });

  describe('la base sólo se escribe si Stripe confirma', () => {
    it('no quita la marca si Stripe falla', async () => {
      paymentGateway.resumeSubscription.mockRejectedValue(
        new PaymentGatewayUnavailableException(),
      );

      await expect(reanudar()).rejects.toBeInstanceOf(
        PaymentGatewayUnavailableException,
      );
      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });

    /**
     * Escribir `false` local sobre una suscripción que Stripe sigue teniendo marcada para no
     * renovar dejaría al usuario creyendo que su plan continúa, y enterándose el día del corte.
     */
    it('no quita la marca si Stripe la mantiene puesta', async () => {
      paymentGateway.resumeSubscription.mockResolvedValue({
        id: 'sub_1',
        cancel_at_period_end: true,
      });

      await expect(reanudar()).rejects.toBeInstanceOf(
        NoScheduledCancellationToResumeException,
      );
      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('409 — no hay nada que reanudar', () => {
    /**
     * Sin baja programada no hay nada que deshacer. Mandarlo a Stripe sería inofensivo allá, pero
     * dejaría al frontend sin saber si el botón que pulsó el usuario hizo algo.
     */
    it('rechaza una suscripción que ya se renueva', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilConBajaProgramada({ cancelAtPeriodEnd: false }),
      );

      await expect(reanudar()).rejects.toBeInstanceOf(
        NoScheduledCancellationToResumeException,
      );
      expect(paymentGateway.resumeSubscription).not.toHaveBeenCalled();
    });

    /**
     * El límite del flujo: una suscripción que Stripe ya dio de baja no se revive. Desde CANCELED
     * el camino es contratar de nuevo, que sí está disponible porque el perfil dejó de estar
     * activo.
     */
    it.each([
      BILLING_PROFILE_STATUS_ENUM.FREE,
      BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])('rechaza un perfil en %s', async (status) => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilConBajaProgramada({ status }),
      );

      await expect(reanudar()).rejects.toBeInstanceOf(
        NoActiveSubscriptionToCancelException,
      );
      expect(paymentGateway.resumeSubscription).not.toHaveBeenCalled();
    });

    it('rechaza una cuenta sin perfil de facturación', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      await expect(reanudar()).rejects.toBeInstanceOf(
        NoActiveSubscriptionToCancelException,
      );
      expect(paymentGateway.resumeSubscription).not.toHaveBeenCalled();
    });

    it('rechaza un perfil ACTIVE sin suscripción en Stripe', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilConBajaProgramada({ stripeSubscriptionId: null }),
      );

      await expect(reanudar()).rejects.toBeInstanceOf(
        NoActiveSubscriptionToCancelException,
      );
      expect(paymentGateway.resumeSubscription).not.toHaveBeenCalled();
    });
  });

  it('no reanuda nada si el usuario no pertenece a la cuenta activa', async () => {
    billingOwnerService.resolveOwner.mockRejectedValue(
      new ForbiddenException('No perteneces a esta cuenta'),
    );

    await expect(reanudar()).rejects.toBeInstanceOf(ForbiddenException);
    expect(billingOwnerService.findProfileByOwner).not.toHaveBeenCalled();
    expect(paymentGateway.resumeSubscription).not.toHaveBeenCalled();
  });
});
