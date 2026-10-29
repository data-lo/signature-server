import { DiditWebhookDispatcherService } from './didit-webhook-dispatcher.service';
import { DiditWebhookPayload } from './didit-webhook-payload.schema';

function payload(
  overrides: Partial<DiditWebhookPayload> = {},
): DiditWebhookPayload {
  return {
    application_id: 'app_1',
    event_id: 'evt_1',
    session_id: 'ses_1',
    status: 'Approved',
    timestamp: 1700000000,
    webhook_type: 'status.updated',
    workflow_id: 'wf_1',
    vendor_data: 'user-1',
    decision: {},
    ...overrides,
  };
}

describe('DiditWebhookDispatcherService', () => {
  let attempts: { findBySession: jest.Mock };
  let biometric: { execute: jest.Mock };
  let identity: { execute: jest.Mock };
  let dispatcher: DiditWebhookDispatcherService;

  beforeEach(() => {
    attempts = { findBySession: jest.fn().mockResolvedValue(null) };
    biometric = { execute: jest.fn().mockResolvedValue(undefined) };
    identity = { execute: jest.fn().mockResolvedValue(undefined) };
    dispatcher = new DiditWebhookDispatcherService(
      attempts as never,
      biometric as never,
      identity as never,
    );
  });

  it('una sesión de firma biométrica va al procesador de firma, con su intento', async () => {
    const attempt = { id: 'attempt-1' };
    attempts.findBySession.mockResolvedValue(attempt);
    const body = payload({
      vendor_data: 'biometric-signature-attempt:attempt-1',
    });

    await expect(dispatcher.dispatch(body)).resolves.toBe(
      'biometric-signature',
    );

    expect(attempts.findBySession).toHaveBeenCalledWith('ses_1');
    expect(biometric.execute).toHaveBeenCalledWith(attempt, body);
    expect(identity.execute).not.toHaveBeenCalled();
  });

  it('cualquier otra sesión va a la verificación de identidad', async () => {
    const body = payload();

    await expect(dispatcher.dispatch(body)).resolves.toBe(
      'identity-verification',
    );

    expect(identity.execute).toHaveBeenCalledWith(body);
    expect(biometric.execute).not.toHaveBeenCalled();
  });

  it('un vendor_data de firma sin intento local se ignora: nunca llega a identidad', async () => {
    await expect(
      dispatcher.dispatch(
        payload({ vendor_data: 'biometric-signature-attempt:desconocido' }),
      ),
    ).resolves.toBe('ignored');

    expect(identity.execute).not.toHaveBeenCalled();
    expect(biometric.execute).not.toHaveBeenCalled();
  });

  it('propaga el error del dominio para que Didit reintente', async () => {
    attempts.findBySession.mockResolvedValue({ id: 'attempt-1' });
    biometric.execute.mockRejectedValue(new Error('MinIO caído'));

    await expect(dispatcher.dispatch(payload())).rejects.toThrow('MinIO caído');
  });
});
