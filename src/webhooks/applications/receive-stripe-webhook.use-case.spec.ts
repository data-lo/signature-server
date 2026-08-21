import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import Stripe = require('stripe');
import { StripeWebhookService } from 'src/stripe/stripe-webhook.service';
import { ReceiveStripeWebhookUseCase } from './receive-stripe-webhook.use-case';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { StripeWebhookSignatureVerifierService } from '../stripe/stripe-webhook-signature-verifier.service';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';

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
    stripeWebhookService = { process: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiveStripeWebhookUseCase,
        { provide: StripeWebhookSignatureVerifierService, useValue: verifier },
        { provide: RegisterWebhookEventUseCase, useValue: register },
        { provide: StripeWebhookService, useValue: stripeWebhookService },
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
});
