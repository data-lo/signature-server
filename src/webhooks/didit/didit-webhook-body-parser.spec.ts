import { Body, Controller, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import * as request from 'supertest';

import { applyGlobalApiPrefix } from 'src/common/constants/api-prefix.constants';
import { WebhookMetricsService } from 'src/metrics/webhook-metrics.service';

import { ReceiveDiditWebhookUseCase } from '../applications/receive-didit-webhook.use-case';
import { RegisterWebhookEventUseCase } from '../applications/register-webhook-event.use-case';
import { DiditWebhookController } from '../didit-webhook.controller';
import { WEBHOOK_PROVIDER_ENUM } from '../enums/webhook-provider.enum';
import { applyDiditWebhookBodyParser } from './didit-webhook-body-parser';
import { DiditWebhookDispatcherService } from './didit-webhook-dispatcher.service';
import { DiditWebhookSignatureVerifierService } from './didit-webhook-signature-verifier.service';

const SECRET = 'secreto-de-prueba';

@Controller('otra-ruta')
class OtherRouteStub {
  @Post()
  echo(@Body() body: unknown) {
    return body;
  }
}

const signedHeaders = (body: string) => ({
  'content-type': 'application/json',
  'x-signature': createHmac('sha256', SECRET).update(body).digest('hex'),
  'x-timestamp': String(Math.floor(Date.now() / 1000)),
});

/**
 * Monta el parser real de Nest (`rawBody: true`), que es lo que ninguna prueba del caso de uso
 * puede ver: el JSON ilegible se responde en esa capa, antes de llegar al controlador.
 */
describe('applyDiditWebhookBodyParser', () => {
  let app: NestExpressApplication;
  const register = {
    register: jest.fn(),
    recordRejectedDelivery: jest.fn(),
    markProcessed: jest.fn(),
    markFailed: jest.fn(),
  };
  const dispatcher = { dispatch: jest.fn() };
  const webhookMetrics = {
    recordDelivery: jest.fn(),
    recordSignatureVerification: jest.fn(),
    recordDispatch: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DiditWebhookController, OtherRouteStub],
      providers: [
        ReceiveDiditWebhookUseCase,
        DiditWebhookSignatureVerifierService,
        { provide: ConfigService, useValue: { get: () => SECRET } },
        { provide: RegisterWebhookEventUseCase, useValue: register },
        { provide: DiditWebhookDispatcherService, useValue: dispatcher },
        { provide: WebhookMetricsService, useValue: webhookMetrics },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
      logger: false,
    });
    applyGlobalApiPrefix(app);
    applyDiditWebhookBodyParser(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    register.register.mockResolvedValue({
      event: { id: 'row-1' },
      alreadyProcessed: false,
    });
    dispatcher.dispatch.mockResolvedValue('ignored');
  });

  it('un cuerpo firmado e ilegible llega al caso de uso: se audita, cuenta como rejected y responde 400', async () => {
    const body = '{no es json';

    const response = await request(app.getHttpServer())
      .post('/api/v1/webhooks/didit')
      .set(signedHeaders(body))
      .send(body)
      .expect(400);

    expect(response.body.message).toBe('Cuerpo de webhook de Didit inválido');
    expect(register.recordRejectedDelivery).toHaveBeenCalledWith(
      WEBHOOK_PROVIDER_ENUM.DIDIT,
      'Cuerpo de Didit ilegible: no es JSON',
      { signatureValid: true, eventType: 'invalid_payload' },
    );
    expect(webhookMetrics.recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'invalid_payload',
        outcome: 'rejected',
      }),
    );
  });

  it('un cuerpo ilegible sin firma válida se rechaza por la firma, sin leerse', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/didit')
      .set({ ...signedHeaders('otro cuerpo') })
      .send('{no es json')
      .expect(401);

    expect(webhookMetrics.recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'unverified', outcome: 'rejected' }),
    );
  });

  it.each(['/api/v1/webhooks/didit', '/api/v1/webhooks/didit/?x=1'])(
    'una entrega correcta en %s verifica el HMAC sobre los bytes exactos y responde 200',
    async (url) => {
      // Espacios y orden de llaves propios: re-serializar el JSON rompería la firma.
      const body = JSON.stringify(
        {
          application_id: 'app_1',
          event_id: 'evt_1',
          session_id: 'ses_1',
          status: 'In Progress',
          timestamp: 1700000000,
          webhook_type: 'status.updated',
          workflow_id: 'wf_1',
          vendor_data: 'user-1',
        },
        null,
        3,
      );

      await request(app.getHttpServer())
        .post(url)
        .set(signedHeaders(body))
        .send(body)
        .expect(200, { received: true, duplicate: false });

      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ event_id: 'evt_1' }),
      );
    },
  );

  it('las demás rutas conservan el parser JSON y su 400 en un cuerpo ilegible', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/otra-ruta')
      .set('content-type', 'application/json')
      .send('{"a":1}')
      .expect(201, { a: 1 });

    await request(app.getHttpServer())
      .post('/api/v1/otra-ruta')
      .set('content-type', 'application/json')
      .send('{no es json')
      .expect(400);

    expect(register.recordRejectedDelivery).not.toHaveBeenCalled();
  });
});
