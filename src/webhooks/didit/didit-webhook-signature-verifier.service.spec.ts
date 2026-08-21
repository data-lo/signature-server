import { createHmac } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DiditWebhookSignatureVerifierService } from './didit-webhook-signature-verifier.service';

const SECRET = 'didit-webhook-secret';

function sign(rawBody: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function nowInSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe('DiditWebhookSignatureVerifierService', () => {
  let service: DiditWebhookSignatureVerifierService;
  let config: { get: jest.Mock };

  beforeEach(async () => {
    config = { get: jest.fn().mockReturnValue(SECRET) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiditWebhookSignatureVerifierService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(DiditWebhookSignatureVerifierService);
  });

  it('acepta un cuerpo firmado con el secreto configurado', () => {
    const rawBody = Buffer.from('{"session_id":"abc","status":"Approved"}');

    expect(service.verify(rawBody, sign(rawBody), nowInSeconds())).toBe(true);
  });

  it('rechaza una firma calculada con otro secreto', () => {
    const rawBody = Buffer.from('{"session_id":"abc","status":"Approved"}');

    expect(
      service.verify(
        rawBody,
        sign(rawBody, 'secreto-del-atacante'),
        nowInSeconds(),
      ),
    ).toBe(false);
  });

  it('rechaza el cuerpo alterado después de firmar', () => {
    const original = Buffer.from('{"session_id":"abc","status":"Declined"}');
    const tampered = Buffer.from('{"session_id":"abc","status":"Approved"}');

    expect(service.verify(tampered, sign(original), nowInSeconds())).toBe(
      false,
    );
  });

  it('rechaza una entrega reenviada fuera de la ventana de tolerancia', () => {
    const rawBody = Buffer.from('{"session_id":"abc","status":"Approved"}');
    const tenMinutesAgo = String(Math.floor(Date.now() / 1000) - 600);

    expect(service.verify(rawBody, sign(rawBody), tenMinutesAgo)).toBe(false);
  });

  it('rechaza cuando falta la cabecera de firma', () => {
    const rawBody = Buffer.from('{"session_id":"abc"}');

    expect(service.verify(rawBody, undefined, nowInSeconds())).toBe(false);
  });

  it('rechaza todo si DIDIT_WEBHOOK_SECRET_KEY no está configurado', () => {
    config.get.mockReturnValue(undefined);
    const rawBody = Buffer.from('{"session_id":"abc"}');

    expect(service.verify(rawBody, sign(rawBody), nowInSeconds())).toBe(false);
  });
});
