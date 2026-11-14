import { WEBHOOK_PROCESSING_STATUS_ENUM } from 'src/webhooks/enums/webhook-processing-status.enum';
import { WEBHOOK_PROVIDER_ENUM } from 'src/webhooks/enums/webhook-provider.enum';

import { MetricsService } from './metrics.service';
import {
  WebhookDeliveryOutcome,
  WebhookMetricsService,
} from './webhook-metrics.service';

const { DIDIT, STRIPE } = WEBHOOK_PROVIDER_ENUM;

describe('WebhookMetricsService', () => {
  let metrics: MetricsService;
  let service: WebhookMetricsService;

  beforeEach(() => {
    metrics = new MetricsService({ enabled: true, path: '/metrics' });
    service = new WebhookMetricsService(metrics);
  });

  it.each<WebhookDeliveryOutcome>([
    'processed',
    'duplicate',
    'rejected',
    'failed',
    'ignored',
  ])('el resultado %s genera series distinguibles', async (outcome) => {
    service.recordDelivery({
      provider: STRIPE,
      eventType: 'invoice.paid',
      outcome,
      durationSeconds: 0.2,
    });

    const body = await metrics.getMetrics();
    const labels = `provider="STRIPE",event_type="invoice.paid",outcome="${outcome}"`;
    expect(body).toContain(`webhook_deliveries_total{${labels}} 1`);
    expect(body).toContain(
      `webhook_delivery_duration_seconds_count{${labels}} 1`,
    );
  });

  it('registra verificaciones de firma válidas e inválidas', async () => {
    service.recordSignatureVerification(DIDIT, true);
    service.recordSignatureVerification(DIDIT, false);

    const body = await metrics.getMetrics();
    expect(body).toContain(
      'webhook_signature_verifications_total{provider="DIDIT",result="valid"} 1',
    );
    expect(body).toContain(
      'webhook_signature_verifications_total{provider="DIDIT",result="invalid"} 1',
    );
  });

  it('registra el destino de una entrega', async () => {
    service.recordDispatch(DIDIT, 'biometric-signature');

    expect(await metrics.getMetrics()).toContain(
      'webhook_dispatch_total{provider="DIDIT",target="biometric-signature"} 1',
    );
  });

  it('publica el backlog', async () => {
    service.setBacklog(STRIPE, WEBHOOK_PROCESSING_STATUS_ENUM.FAILED, 2, 340);

    const body = await metrics.getMetrics();
    expect(body).toContain(
      'webhook_events_pending{provider="STRIPE",status="FAILED"} 2',
    );
    expect(body).toContain(
      'webhook_oldest_pending_seconds{provider="STRIPE",status="FAILED"} 340',
    );
  });

  describe('event_type controlado', () => {
    const labelFor = async (
      provider: WEBHOOK_PROVIDER_ENUM,
      eventType: string,
    ) => {
      service.recordDelivery({
        provider,
        eventType,
        outcome: 'processed',
        durationSeconds: 0.1,
      });
      const body = await metrics.getMetrics();
      return /webhook_deliveries_total\{[^}]*event_type="([^"]*)"/.exec(
        body,
      )?.[1];
    };

    it.each([
      [DIDIT, 'status.updated', 'status.updated'],
      [DIDIT, 'data.updated', 'data.updated'],
      [DIDIT, 'ses_123', 'unknown'],
      [DIDIT, 'ana@correo.mx', 'unknown'],
      [DIDIT, 'status.nuevo', 'unknown'],
      [DIDIT, 'invalid_payload', 'invalid_payload'],
      [DIDIT, 'unverified', 'unverified'],
      [
        STRIPE,
        'customer.subscription.updated',
        'customer.subscription.updated',
      ],
      [STRIPE, 'evt_1Abc', 'unknown'],
      [STRIPE, 'ANA@correo.mx', 'unknown'],
      [STRIPE, `a.${'b'.repeat(200)}`, 'unknown'],
      [STRIPE, 'unverified', 'unverified'],
    ])('%s: %s se publica como %s', async (provider, eventType, expected) => {
      expect(await labelFor(provider, eventType)).toBe(expected);
    });
  });

  describe('un error al emitir no afecta el procesamiento', () => {
    it('recordDelivery no lanza si falla el contador', () => {
      const inc = jest
        .spyOn(
          (service as unknown as { deliveriesTotal: { inc: () => void } })
            .deliveriesTotal,
          'inc',
        )
        .mockImplementation(() => {
          throw new Error('labels inválidos');
        });

      expect(() =>
        service.recordDelivery({
          provider: DIDIT,
          eventType: 'status.updated',
          outcome: 'processed',
          durationSeconds: 0.1,
        }),
      ).not.toThrow();
      expect(inc).toHaveBeenCalledTimes(1);
    });
  });

  it('con las métricas apagadas no registra nada', async () => {
    const disabledMetrics = new MetricsService({
      enabled: false,
      path: '/metrics',
    });
    const disabled = new WebhookMetricsService(disabledMetrics);

    disabled.recordDelivery({
      provider: DIDIT,
      eventType: 'status.updated',
      outcome: 'processed',
      durationSeconds: 0.1,
    });
    disabled.recordSignatureVerification(DIDIT, true);

    expect(disabled.isEnabled()).toBe(false);
    const body = await disabledMetrics.getMetrics();
    expect(body).not.toContain('webhook_deliveries_total{');
    expect(body).not.toContain('webhook_signature_verifications_total{');
  });
});
