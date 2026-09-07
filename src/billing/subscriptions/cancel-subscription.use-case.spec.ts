import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { StripePaymentService } from 'src/payments/stripe/stripe-payment.service';
import { PaymentGatewayUnavailableException } from 'src/payments/exceptions/payments.exceptions';
import { CancelSubscriptionUseCase } from './cancel-subscription.use-case';
import { BillingProfileEntity } from '../profiles/billing-profile.entity';
import { BillingOwnerService } from '../profiles/billing-owner.service';
import { BILLING_PROFILE_STATUS_ENUM } from '../enums/billing-profile-status.enum';
import {
  NoActiveSubscriptionToCancelException,
  SubscriptionCancellationAlreadyScheduledException,
} from '../exceptions/billing.exceptions';

const PERIOD_END = new Date('2030-02-01T00:00:00.000Z');

function perfilActivo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
    currentPlanType: 'plus',
    stripeSubscriptionId: 'sub_1',
    stripeCustomerId: 'cus_1',
    cancelAtPeriodEnd: false,
    currentPeriodStart: new Date('2030-01-01T00:00:00.000Z'),
    currentPeriodEnd: PERIOD_END,
    ...overrides,
  };
}

describe('CancelSubscriptionUseCase', () => {
  let useCase: CancelSubscriptionUseCase;
  let billingProfileRepository: { update: jest.Mock };
  let billingOwnerService: {
    resolveOwner: jest.Mock;
    findProfileByOwner: jest.Mock;
  };
  let paymentGateway: { scheduleSubscriptionCancellation: jest.Mock };

  beforeEach(async () => {
    billingProfileRepository = { update: jest.fn() };
    billingOwnerService = {
      resolveOwner: jest
        .fn()
        .mockResolvedValue({ personalAccountId: 'account-1' }),
      findProfileByOwner: jest.fn().mockResolvedValue(perfilActivo()),
    };
    paymentGateway = {
      scheduleSubscriptionCancellation: jest
        .fn()
        .mockResolvedValue({ id: 'sub_1', cancel_at_period_end: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CancelSubscriptionUseCase,
        {
          provide: getRepositoryToken(BillingProfileEntity),
          useValue: billingProfileRepository,
        },
        { provide: BillingOwnerService, useValue: billingOwnerService },
        { provide: StripePaymentService, useValue: paymentGateway },
      ],
    }).compile();

    useCase = module.get(CancelSubscriptionUseCase);
  });

  function cancelar() {
    return useCase.execute({ userId: 'user-1', accountId: 'account-1' });
  }

  describe('cancelación exitosa', () => {
    it('le pide a Stripe que no renueve la suscripción', async () => {
      await cancelar();

      expect(
        paymentGateway.scheduleSubscriptionCancellation,
      ).toHaveBeenCalledWith('sub_1');
    });

    /**
     * El corazón de la historia: el cliente pagó un mes y se lo queda entero. Sólo cambia la
     * intención de no renovar.
     */
    it('marca la baja sin tocar estado, plan, periodo ni suscripción', async () => {
      await cancelar();

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-1',
        {
          cancelAtPeriodEnd: true,
        },
      );
    });

    it('responde el estado vigente y la fecha efectiva de término', async () => {
      const respuesta = await cancelar();

      expect(respuesta).toEqual({
        status: BILLING_PROFILE_STATUS_ENUM.ACTIVE,
        planType: 'plus',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: PERIOD_END,
      });
    });

    /**
     * `resolveOwner` traduce la cuenta activa al propietario del dinero, así que una organización
     * cancela su suscripción compartida por el mismo camino que una persona la suya.
     */
    it('funciona igual para una organización', async () => {
      billingOwnerService.resolveOwner.mockResolvedValue({
        organizationId: 'org-1',
      });
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilActivo({ id: 'profile-org' }),
      );

      await cancelar();

      expect(billingProfileRepository.update).toHaveBeenCalledWith(
        'profile-org',
        { cancelAtPeriodEnd: true },
      );
    });
  });

  describe('la base sólo se escribe si Stripe confirma', () => {
    /**
     * El orden es la regla entera del flujo: escribir antes dejaría al usuario viendo "no se
     * renovará" mientras la suscripción sigue programada para cobrarse, y el siguiente cargo
     * llegaría sin aviso.
     */
    it('no marca nada si Stripe falla', async () => {
      paymentGateway.scheduleSubscriptionCancellation.mockRejectedValue(
        new PaymentGatewayUnavailableException(),
      );

      await expect(cancelar()).rejects.toBeInstanceOf(
        PaymentGatewayUnavailableException,
      );
      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });

    /**
     * Un 200 confirma que la petición se procesó, no que la baja quedara programada. Se mira el
     * valor devuelto y no sólo la ausencia de excepción.
     */
    it('no marca nada si Stripe responde sin la baja programada', async () => {
      paymentGateway.scheduleSubscriptionCancellation.mockResolvedValue({
        id: 'sub_1',
        cancel_at_period_end: false,
      });

      await expect(cancelar()).rejects.toBeInstanceOf(
        NoActiveSubscriptionToCancelException,
      );
      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('409 — no hay nada que cancelar', () => {
    it('rechaza una cuenta sin perfil de facturación', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(null);

      await expect(cancelar()).rejects.toBeInstanceOf(
        NoActiveSubscriptionToCancelException,
      );
      expect(
        paymentGateway.scheduleSubscriptionCancellation,
      ).not.toHaveBeenCalled();
    });

    it.each([
      BILLING_PROFILE_STATUS_ENUM.FREE,
      BILLING_PROFILE_STATUS_ENUM.INCOMPLETE,
      BILLING_PROFILE_STATUS_ENUM.PAST_DUE,
      BILLING_PROFILE_STATUS_ENUM.CANCELED,
    ])('rechaza un perfil en %s', async (status) => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilActivo({ status }),
      );

      await expect(cancelar()).rejects.toBeInstanceOf(
        NoActiveSubscriptionToCancelException,
      );
      expect(
        paymentGateway.scheduleSubscriptionCancellation,
      ).not.toHaveBeenCalled();
    });

    /**
     * Un perfil ACTIVE sin suscripción en el proveedor no es teórico: puede venir de una
     * corrección manual. Pedirle a Stripe que actualice `undefined` daría un error suyo, y el
     * usuario leería una avería nuestra donde lo cierto es que no hay nada que cancelar.
     */
    it('rechaza un perfil ACTIVE sin suscripción en Stripe', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilActivo({ stripeSubscriptionId: null }),
      );

      await expect(cancelar()).rejects.toBeInstanceOf(
        NoActiveSubscriptionToCancelException,
      );
      expect(
        paymentGateway.scheduleSubscriptionCancellation,
      ).not.toHaveBeenCalled();
    });
  });

  describe('409 — cancelación duplicada', () => {
    /**
     * Se corta antes de llamar a Stripe. Repetirlo allá sería inofensivo, pero gastaría una
     * llamada por cada doble clic y dejaría al frontend sin distinguir "acabo de cancelar" de
     * "ya estaba cancelado".
     */
    it('rechaza cancelar lo que ya estaba programado', async () => {
      billingOwnerService.findProfileByOwner.mockResolvedValue(
        perfilActivo({ cancelAtPeriodEnd: true }),
      );

      await expect(cancelar()).rejects.toBeInstanceOf(
        SubscriptionCancellationAlreadyScheduledException,
      );
      expect(
        paymentGateway.scheduleSubscriptionCancellation,
      ).not.toHaveBeenCalled();
      expect(billingProfileRepository.update).not.toHaveBeenCalled();
    });
  });

  /**
   * El header lo elige el cliente: sin comprobar la pertenencia, cambiar un valor en la petición
   * dejaría cancelar la suscripción de una organización ajena.
   */
  it('no cancela nada si el usuario no pertenece a la cuenta activa', async () => {
    billingOwnerService.resolveOwner.mockRejectedValue(
      new ForbiddenException('No perteneces a esta cuenta'),
    );

    await expect(cancelar()).rejects.toBeInstanceOf(ForbiddenException);
    expect(billingOwnerService.findProfileByOwner).not.toHaveBeenCalled();
    expect(
      paymentGateway.scheduleSubscriptionCancellation,
    ).not.toHaveBeenCalled();
  });
});
