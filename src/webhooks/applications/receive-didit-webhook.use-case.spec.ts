import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ReceiveDiditWebhookUseCase } from './receive-didit-webhook.use-case';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { DiditWebhookSignatureVerifierService } from '../didit/didit-webhook-signature-verifier.service';
import { DIDIT_VERIFICATION_PROCESSOR } from '../interfaces/didit-verification-processor.interface';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';

const PAYLOAD = { session_id: 'ses_1', status: 'Approved' };
const RAW_BODY = Buffer.from(JSON.stringify(PAYLOAD));
const HEADERS = { signature: 'firma', timestamp: '1700000000' };

describe('ReceiveDiditWebhookUseCase', () => {
  let useCase: ReceiveDiditWebhookUseCase;
  let verifier: { verify: jest.Mock };
  let register: {
    register: jest.Mock;
    recordRejectedDelivery: jest.Mock;
    markProcessed: jest.Mock;
    markFailed: jest.Mock;
  };
  let processor: { execute: jest.Mock };

  beforeEach(async () => {
    verifier = { verify: jest.fn().mockReturnValue(true) };
    register = {
      register: jest.fn().mockResolvedValue({
        event: { id: 'evt-row-1' },
        alreadyProcessed: false,
      }),
      recordRejectedDelivery: jest.fn().mockResolvedValue(undefined),
      markProcessed: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    processor = { execute: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiveDiditWebhookUseCase,
        { provide: DiditWebhookSignatureVerifierService, useValue: verifier },
        { provide: RegisterWebhookEventUseCase, useValue: register },
        { provide: DIDIT_VERIFICATION_PROCESSOR, useValue: processor },
      ],
    }).compile();

    useCase = module.get(ReceiveDiditWebhookUseCase);
  });

  it('delega al procesamiento del resultado de verificación y marca el evento PROCESSED', async () => {
    const result = await useCase.execute({ rawBody: RAW_BODY, ...HEADERS });

    expect(processor.execute).toHaveBeenCalledWith(PAYLOAD);
    expect(register.markProcessed).toHaveBeenCalledWith('evt-row-1');
    expect(result).toEqual({ received: true, duplicate: false });
  });

  it('usa session_id + status como clave de idempotencia', async () => {
    await useCase.execute({ rawBody: RAW_BODY, ...HEADERS });

    expect(register.register).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: WEBHOOK_PROVIDER_ENUM.DIDIT,
        providerEventId: 'ses_1:Approved',
        eventType: 'Approved',
      }),
    );
  });

  describe('firma inválida', () => {
    beforeEach(() => verifier.verify.mockReturnValue(false));

    it('responde 401 sin registrar el evento ni ejecutar lógica de negocio', async () => {
      await expect(
        useCase.execute({ rawBody: RAW_BODY, ...HEADERS }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(processor.execute).not.toHaveBeenCalled();
      expect(register.register).not.toHaveBeenCalled();
    });

    it('deja constancia de auditoría sin almacenar el payload', async () => {
      await expect(
        useCase.execute({ rawBody: RAW_BODY, ...HEADERS }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(register.recordRejectedDelivery).toHaveBeenCalledWith(
        WEBHOOK_PROVIDER_ENUM.DIDIT,
        expect.any(String),
      );
    });
  });

  it('no vuelve a ejecutar el dominio cuando el evento ya fue procesado', async () => {
    register.register.mockResolvedValue({
      event: { id: 'evt-row-1' },
      alreadyProcessed: true,
    });

    const result = await useCase.execute({ rawBody: RAW_BODY, ...HEADERS });

    expect(processor.execute).not.toHaveBeenCalled();
    expect(register.markProcessed).not.toHaveBeenCalled();
    expect(result).toEqual({ received: true, duplicate: true });
  });

  it('marca FAILED con el detalle y propaga el error cuando el dominio falla', async () => {
    processor.execute.mockRejectedValue(
      new Error('base de datos no disponible'),
    );

    await expect(
      useCase.execute({ rawBody: RAW_BODY, ...HEADERS }),
    ).rejects.toThrow('base de datos no disponible');

    expect(register.markFailed).toHaveBeenCalledWith(
      'evt-row-1',
      expect.any(Error),
    );
    expect(register.markProcessed).not.toHaveBeenCalled();
  });

  it('rechaza con 400 un cuerpo firmado pero ilegible', async () => {
    await expect(
      useCase.execute({ rawBody: Buffer.from('no-es-json'), ...HEADERS }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(processor.execute).not.toHaveBeenCalled();
  });
});
