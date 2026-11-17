import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import Stripe = require('stripe');
import { StripeWebhookService } from 'src/payments/stripe/stripe-webhook.service';
import { ReceiveStripeWebhookUseCase } from './receive-stripe-webhook.use-case';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { StripeWebhookSignatureVerifierService } from '../stripe/stripe-webhook-signature-verifier.service';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { WebhookMetricsService } from 'src/metrics/webhook-metrics.service';

const STRIPE_EVENT = {
  id: 'evt_123',
  type: 'invoice.paid',
} as Stripe.Event;

const INPUT = { rawBody: Buffer.from('{}'), signature: 't=1,v1=abc' };

describe('ReceiveStripeWebhookUseCase', () => {
  let useCase: ReceiveStripeWebhookUseCase;
  let verifier: { verify: jest.Mock };
  let register: {
    register: jest.Mock;
    recordRejectedDelivery: jest.Mock;
    markProcessed: jest.Mock;
    markFailed: jest.Mock;
  };
  let stripeWebhookService: { process: jest.Mock };
  let webhookMetrics: {
    recordDelivery: jest.Mock;
    recordSignatureVerification: jest.Mock;
    recordDispatch: jest.Mock;
  };

  beforeEach(async () => {
    verifier = { verify: jest.fn().mockReturnValue(STRIPE_EVENT) };
    register = {
      register: jest
        .fn()
        .mockResolvedValue({ event: { id: 'row-1' }, alreadyProcessed: false }),
      recordRejectedDelivery: jest.fn().mockResolvedValue(undefined),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    stripeWebhookService = { process: jest.fn().mockResolvedValue('handled') };
    webhookMetrics = {
      recordDelivery: jest.fn(),
      recordSignatureVerification: jest.fn(),
      recordDispatch: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiveStripeWebhookUseCase,
        { provide: StripeWebhookSignatureVerifierService, useValue: verifier },
        { provide: RegisterWebhookEventUseCase, useValue: register },
        { provide: StripeWebhookService, useValue: stripeWebhookService },
        { provide: WebhookMetricsService, useValue: webhookMetrics },
      ],
    }).compile();

    useCase = module.get(ReceiveStripeWebhookUseCase);
  });

  it('registra el evento con el id de Stripe y delega en StripeWebhookService', async () => {
    const result = await useCase.execute(INPUT);

    expect(register.register).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: WEBHOOK_PROVIDER_ENUM.STRIPE,
        providerEventId: 'evt_123',
        eventType: 'invoice.paid',
      }),
    );
    expect(stripeWebhookService.process).toHaveBeenCalledWith(STRIPE_EVENT);
    expect(register.markProcessed).toHaveBeenCalledWith('row-1');
    expect(result).toEqual({ received: true, duplicate: false });
  });

  it('responde 401 sin ejecutar reglas de pago cuando la firma no verifica', async () => {
    verifier.verify.mockReturnValue(null);

    await expect(useCase.execute(INPUT)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(stripeWebhookService.process).not.toHaveBeenCalled();
    expect(register.register).not.toHaveBeenCalled();
    expect(register.recordRejectedDelivery).toHaveBeenCalledWith(
      WEBHOOK_PROVIDER_ENUM.STRIPE,
      expect.any(String),
    );
  });

  it('responde con éxito sin reprocesar una re-entrega del mismo evento', async () => {
    register.register.mockResolvedValue({
      event: { id: 'row-1' },
      alreadyProcessed: true,
    });

    const result = await useCase.execute(INPUT);

    expect(stripeWebhookService.process).not.toHaveBeenCalled();
    expect(result).toEqual({ received: true, duplicate: true });
  });

  it('marca FAILED y propaga para que Stripe reintente', async () => {
    stripeWebhookService.process.mockRejectedValue(
      new Error('conexión perdida'),
    );

    await expect(useCase.execute(INPUT)).rejects.toThrow('conexión perdida');

    expect(register.markFailed).toHaveBeenCalledWith(
      'row-1',
      expect.any(Error),
    );
    expect(register.markProcessed).not.toHaveBeenCalled();
  });

  describe('métricas', () => {
    const delivery = (eventType: string, outcome: string) =>
      expect(webhookMetrics.recordDelivery).toHaveBeenCalledWith({
        provider: WEBHOOK_PROVIDER_ENUM.STRIPE,
        eventType,
        outcome,
        durationSeconds: expect.any(Number),
      });

    afterEach(() => {
      expect(webhookMetrics.recordDelivery).toHaveBeenCalledTimes(1);
    });

    it('un evento atendido queda como processed', async () => {
      await useCase.execute(INPUT);

      delivery('invoice.paid', 'processed');
      expect(webhookMetrics.recordSignatureVerification).toHaveBeenCalledWith(
        WEBHOOK_PROVIDER_ENUM.STRIPE,
        true,
      );
      expect(webhookMetrics.recordDispatch).toHaveBeenCalledWith(
        WEBHOOK_PROVIDER_ENUM.STRIPE,
        'payments',
      );
    });

    it('un evento no soportado queda como ignored, se marca PROCESSED y responde 200', async () => {
      stripeWebhookService.process.mockResolvedValue('ignored');

      const result = await useCase.execute(INPUT);

      delivery('invoice.paid', 'ignored');
      expect(webhookMetrics.recordDispatch).toHaveBeenCalledWith(
        WEBHOOK_PROVIDER_ENUM.STRIPE,
        'ignored',
      );
      expect(register.markProcessed).toHaveBeenCalledWith('row-1');
      expect(register.markFailed).not.toHaveBeenCalled();
      expect(result).toEqual({ received: true, duplicate: false });
    });

    it('una re-entrega queda como duplicate', async () => {
      register.register.mockResolvedValue({
        event: { id: 'row-1' },
        alreadyProcessed: true,
      });

      await useCase.execute(INPUT);

      delivery('invoice.paid', 'duplicate');
      expect(webhookMetrics.recordDispatch).not.toHaveBeenCalled();
    });

    it('una firma inválida queda como rejected, sin leer el tipo del cuerpo', async () => {
      verifier.verify.mockReturnValue(null);

      await expect(useCase.execute(INPUT)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      delivery('unverified', 'rejected');
      expect(webhookMetrics.recordSignatureVerification).toHaveBeenCalledWith(
        WEBHOOK_PROVIDER_ENUM.STRIPE,
        false,
      );
    });

    it('un error del dominio queda como failed', async () => {
      stripeWebhookService.process.mockRejectedValue(new Error('caído'));

      await expect(useCase.execute(INPUT)).rejects.toThrow('caído');

      delivery('invoice.paid', 'failed');
      expect(webhookMetrics.recordDispatch).not.toHaveBeenCalled();
    });

    it('un error de la base al registrar queda como failed y se propaga', async () => {
      register.register.mockRejectedValue(new Error('sin base'));

      await expect(useCase.execute(INPUT)).rejects.toThrow('sin base');

      delivery('invoice.paid', 'failed');
    });

    it('un error de la base al cerrar el estado queda como failed y se propaga', async () => {
      register.markProcessed.mockRejectedValue(new Error('sin base'));

      await expect(useCase.execute(INPUT)).rejects.toThrow('sin base');

      delivery('invoice.paid', 'failed');
    });
  });
});
