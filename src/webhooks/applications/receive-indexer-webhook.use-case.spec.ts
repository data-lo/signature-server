import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ReceiveIndexerWebhookUseCase } from './receive-indexer-webhook.use-case';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';

const PAYLOAD = {
  jobId: '9f2c4e1a7b3d5f60819a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
  documentId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  state: 'received',
  duplicate: true,
  clientDocumentId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
};
const HEADERS = { signature: 'firma', timestamp: '1700000000' };

function bodyOf(payload: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

describe('ReceiveIndexerWebhookUseCase', () => {
  let useCase: ReceiveIndexerWebhookUseCase;
  let verifier: { verify: jest.Mock };
  let register: {
    register: jest.Mock;
    recordRejectedDelivery: jest.Mock;
    markProcessed: jest.Mock;
    markFailed: jest.Mock;
  };
  let processNotification: { execute: jest.Mock };

  beforeEach(() => {
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
    processNotification = { execute: jest.fn().mockResolvedValue(true) };

    useCase = new ReceiveIndexerWebhookUseCase(
      verifier as never,
      register as never,
      processNotification as never,
    );
  });

  it('entrega la notificación al dominio y marca el evento PROCESSED', async () => {
    const result = await useCase.execute({
      rawBody: bodyOf(PAYLOAD),
      ...HEADERS,
    });

    expect(processNotification.execute).toHaveBeenCalledWith({
      jobId: PAYLOAD.jobId,
      externalDocumentId: PAYLOAD.documentId,
      clientDocumentId: PAYLOAD.clientDocumentId,
      state: 'received',
      duplicate: true,
      error: undefined,
    });
    expect(register.markProcessed).toHaveBeenCalledWith('evt-row-1');
    expect(result).toEqual({ received: true, duplicate: false });
  });

  it('registra la entrega bajo el proveedor INDEXER, con el job, el documento y el estado como clave', async () => {
    await useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS });

    expect(register.register).toHaveBeenCalledWith({
      provider: WEBHOOK_PROVIDER_ENUM.INDEXER,
      providerEventId: `${PAYLOAD.jobId}:${PAYLOAD.clientDocumentId}:received`,
      providerResourceId: PAYLOAD.jobId,
      eventType: 'received',
      payload: PAYLOAD,
    });
  });

  it('cada estado del mismo job es un evento propio', async () => {
    await useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS });
    await useCase.execute({
      rawBody: bodyOf({ ...PAYLOAD, state: 'indexed' }),
      ...HEADERS,
    });

    const [first, second] = register.register.mock.calls.map(
      ([input]) => input.providerEventId,
    );
    expect(first).not.toEqual(second);
  });

  it('dos documentos con el mismo jobId son eventos distintos', async () => {
    await useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS });
    await useCase.execute({
      rawBody: bodyOf({
        ...PAYLOAD,
        clientDocumentId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
      }),
      ...HEADERS,
    });

    const [first, second] = register.register.mock.calls.map(
      ([input]) => input.providerEventId,
    );
    expect(first).not.toEqual(second);
  });

  it('una reentrega ya procesada responde 200 sin tocar el dominio', async () => {
    register.register.mockResolvedValue({
      event: { id: 'evt-row-1' },
      alreadyProcessed: true,
    });

    await expect(
      useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS }),
    ).resolves.toEqual({ received: true, duplicate: true });

    expect(processNotification.execute).not.toHaveBeenCalled();
    expect(register.markProcessed).not.toHaveBeenCalled();
  });

  it('una notificación que el dominio ignora responde 200 como duplicada', async () => {
    processNotification.execute.mockResolvedValue(false);

    await expect(
      useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS }),
    ).resolves.toEqual({ received: true, duplicate: true });

    expect(register.markProcessed).toHaveBeenCalledWith('evt-row-1');
  });

  describe('firma inválida', () => {
    beforeEach(() => verifier.verify.mockReturnValue(false));

    it('responde 401 y audita sin leer el cuerpo ni tocar el dominio', async () => {
      await expect(
        useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS }),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(register.recordRejectedDelivery).toHaveBeenCalledWith(
        WEBHOOK_PROVIDER_ENUM.INDEXER,
        expect.any(String),
      );
      expect(register.register).not.toHaveBeenCalled();
      expect(processNotification.execute).not.toHaveBeenCalled();
    });
  });

  describe('payload inválido', () => {
    it.each([
      ['un esquema incumplido', bodyOf({ ...PAYLOAD, state: 'processing' })],
      ['un cuerpo que no es JSON', Buffer.from('no es json')],
    ])('responde 400 y audita ante %s', async (_, rawBody) => {
      await expect(
        useCase.execute({ rawBody, ...HEADERS }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(register.recordRejectedDelivery).toHaveBeenCalledWith(
        WEBHOOK_PROVIDER_ENUM.INDEXER,
        expect.any(String),
        { signatureValid: true, eventType: 'invalid_payload' },
      );
      expect(register.register).not.toHaveBeenCalled();
      expect(processNotification.execute).not.toHaveBeenCalled();
    });
  });

  describe('job inexistente', () => {
    it('marca el evento FAILED y propaga el error controlado', async () => {
      const error = new NotFoundException('sin job');
      processNotification.execute.mockRejectedValue(error);

      await expect(
        useCase.execute({ rawBody: bodyOf(PAYLOAD), ...HEADERS }),
      ).rejects.toBe(error);

      expect(register.markFailed).toHaveBeenCalledWith('evt-row-1', error);
      expect(register.markProcessed).not.toHaveBeenCalled();
    });
  });
});
