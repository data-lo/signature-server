import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ProcessDiditVerificationResultUseCase } from 'src/identity-verification/applications/process-didit-verification-result.use-case';
import { ReceiveDiditWebhookUseCase } from './receive-didit-webhook.use-case';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { DiditWebhookSignatureVerifierService } from '../didit/didit-webhook-signature-verifier.service';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';

/** Una entrega real de Didit: el evento final aprobado. */
const PAYLOAD = {
  application_id: 'app_1',
  event_id: 'evt_1',
  session_id: 'ses_1',
  status: 'Approved',
  timestamp: 1700000000,
  webhook_type: 'status.updated',
  workflow_id: 'wf_1',
  vendor_data: 'user-1',
  decision: { id_verifications: [{ status: 'Approved' }] },
};
const HEADERS = { signature: 'firma', timestamp: '1700000000' };

function bodyOf(payload: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

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
        {
          provide: ProcessDiditVerificationResultUseCase,
          useValue: processor,
        },
      ],
    }).compile();

    useCase = module.get(ReceiveDiditWebhookUseCase);
  });

  it('delega al procesamiento del resultado de verificación y marca el evento PROCESSED', async () => {
    const result = await useCase.execute({
      rawBody: bodyOf(PAYLOAD),
      ...HEADERS,
    });

    expect(processor.execute).toHaveBeenCalledWith(PAYLOAD);
    expect(register.markProcessed).toHaveBeenCalledWith('evt-row-1');
    expect(result).toEqual({ received: true, duplicate: false });
  });

  it('usa event_id como clave de idempotencia y guarda session_id como recurso', async () => {
    await useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS });

    expect(register.register).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: WEBHOOK_PROVIDER_ENUM.DIDIT,
        providerEventId: 'evt_1',
        providerResourceId: 'ses_1',
        eventType: 'status.updated',
      }),
    );
  });

  it('distingue dos estados de la misma sesión: cada uno es un evento propio', async () => {
    await useCase.execute({
      rawBody: bodyOf({
        ...PAYLOAD,
        event_id: 'evt_0',
        status: 'In Progress',
        decision: undefined,
      }),
      ...HEADERS,
    });
    await useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS });

    expect(register.register.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        providerEventId: 'evt_0',
        providerResourceId: 'ses_1',
      }),
      expect.objectContaining({
        providerEventId: 'evt_1',
        providerResourceId: 'ses_1',
      }),
    ]);
  });

  describe('firma inválida', () => {
    beforeEach(() => verifier.verify.mockReturnValue(false));

    it('responde 401 sin registrar el evento ni ejecutar lógica de negocio', async () => {
      await expect(
        useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(processor.execute).not.toHaveBeenCalled();
      expect(register.register).not.toHaveBeenCalled();
    });

    it('deja constancia de auditoría sin almacenar el payload', async () => {
      await expect(
        useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(register.recordRejectedDelivery).toHaveBeenCalledWith(
        WEBHOOK_PROVIDER_ENUM.DIDIT,
        expect.any(String),
      );
    });
  });

  describe('payload inválido', () => {
    /** Auténtico —la firma verificó— pero incompleto: falta `event_id`. */
    const sinEventId = { ...PAYLOAD, event_id: undefined };

    it('responde 400 sin tocar la verificación ni el estado del usuario', async () => {
      await expect(
        useCase.execute({ rawBody: bodyOf(sinEventId), ...HEADERS }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(register.register).not.toHaveBeenCalled();
      expect(processor.execute).not.toHaveBeenCalled();
    });

    it('lo audita como firma válida: no es un impostor, es un contrato roto', async () => {
      await expect(
        useCase.execute({ rawBody: bodyOf(sinEventId), ...HEADERS }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(register.recordRejectedDelivery).toHaveBeenCalledWith(
        WEBHOOK_PROVIDER_ENUM.DIDIT,
        expect.stringContaining('event_id'),
        { signatureValid: true, eventType: 'invalid_payload' },
      );
    });

    it('rechaza un Approved sin decision', async () => {
      await expect(
        useCase.execute({
          rawBody: bodyOf({ ...PAYLOAD, decision: undefined }),
          ...HEADERS,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(processor.execute).not.toHaveBeenCalled();
    });
  });

  it('no vuelve a ejecutar el dominio cuando el evento ya fue procesado', async () => {
    register.register.mockResolvedValue({
      event: { id: 'evt-row-1' },
      alreadyProcessed: true,
    });

    const result = await useCase.execute({
      rawBody: bodyOf(PAYLOAD),
      ...HEADERS,
    });

    expect(processor.execute).not.toHaveBeenCalled();
    expect(register.markProcessed).not.toHaveBeenCalled();
    expect(result).toEqual({ received: true, duplicate: true });
  });

  it('marca FAILED con el detalle y propaga el error cuando el dominio falla', async () => {
    processor.execute.mockRejectedValue(
      new Error('base de datos no disponible'),
    );

    await expect(
      useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS }),
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
