import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { RegisterWebhookEventUseCase } from './register-webhook-event.use-case';
import { WebhookEventEntity } from '../entities/webhook-event.entity';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { WEBHOOK_PROCESSING_STATUS_ENUM } from '../enums/webhook-processing-status.enum';

const INPUT = {
  provider: WEBHOOK_PROVIDER_ENUM.STRIPE,
  providerEventId: 'evt_123',
  eventType: 'invoice.paid',
  payload: { id: 'evt_123' },
};

function uniqueViolation(): QueryFailedError {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate key'));
  (error as unknown as { driverError: { code: string } }).driverError = {
    code: '23505',
  };
  return error;
}

describe('RegisterWebhookEventUseCase', () => {
  let useCase: RegisterWebhookEventUseCase;
  let repository: {
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    repository = {
      findOne: jest.fn().mockResolvedValue(null),
      findOneBy: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'row-1', ...data })),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegisterWebhookEventUseCase,
        {
          provide: getRepositoryToken(WebhookEventEntity),
          useValue: repository,
        },
      ],
    }).compile();

    useCase = module.get(RegisterWebhookEventUseCase);
  });

  it('inserta la entrega nueva en RECEIVED con la firma marcada como válida', async () => {
    const { event, alreadyProcessed } = await useCase.register(INPUT);

    expect(alreadyProcessed).toBe(false);
    expect(event.id).toBe('row-1');
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: WEBHOOK_PROVIDER_ENUM.STRIPE,
        providerEventId: 'evt_123',
        signatureValid: true,
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.RECEIVED,
      }),
    );
  });

  it('reporta como duplicado un evento que ya está en PROCESSED', async () => {
    repository.findOne.mockResolvedValue({
      id: 'row-1',
      processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.PROCESSED,
    });

    const { alreadyProcessed } = await useCase.register(INPUT);

    expect(alreadyProcessed).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('reintenta una entrega que quedó en FAILED en vez de descartarla como duplicado', async () => {
    repository.findOne.mockResolvedValue({
      id: 'row-1',
      processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
    });
    repository.findOneBy.mockResolvedValue({ id: 'row-1' });

    const { alreadyProcessed } = await useCase.register(INPUT);

    expect(alreadyProcessed).toBe(false);
    expect(repository.update).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.RECEIVED,
        error: null,
        processedAt: null,
      }),
    );
  });

  it('trata como duplicado la carrera que pierde contra el índice único', async () => {
    repository.save.mockRejectedValueOnce(uniqueViolation());
    repository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'row-ganadora' });

    const { event, alreadyProcessed } = await useCase.register(INPUT);

    expect(alreadyProcessed).toBe(true);
    expect(event.id).toBe('row-ganadora');
  });

  it('no busca duplicados cuando el proveedor no dio identificador', async () => {
    const { alreadyProcessed } = await useCase.register({
      ...INPUT,
      providerEventId: null,
    });

    expect(repository.findOne).not.toHaveBeenCalled();
    expect(alreadyProcessed).toBe(false);
  });

  it('audita una entrega rechazada sin payload ni identificador', async () => {
    await useCase.recordRejectedDelivery(
      WEBHOOK_PROVIDER_ENUM.DIDIT,
      'Firma HMAC de Didit inválida',
    );

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: WEBHOOK_PROVIDER_ENUM.DIDIT,
        providerEventId: null,
        payload: null,
        signatureValid: false,
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
      }),
    );
  });

  it('no propaga el fallo al auditar: un 401 no debe volverse 500', async () => {
    repository.save.mockRejectedValue(new Error('base de datos caída'));

    await expect(
      useCase.recordRejectedDelivery(
        WEBHOOK_PROVIDER_ENUM.STRIPE,
        'Firma inválida',
      ),
    ).resolves.toBeUndefined();
  });

  it('guarda el detalle del error al marcar FAILED', async () => {
    await useCase.markFailed('row-1', new Error('timeout'));

    expect(repository.update).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({
        processingStatus: WEBHOOK_PROCESSING_STATUS_ENUM.FAILED,
        error: 'Error: timeout',
      }),
    );
  });
});
