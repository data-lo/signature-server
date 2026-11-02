import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { IndexerWebhookSignatureVerifierService } from './indexer-webhook-signature-verifier.service';

const SECRET = 'indexer-webhook-secret';
const BODY = Buffer.from('{"jobId":"abc","state":"received"}');

function sign(rawBody: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function nowInSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function verifierWith(secret: string | undefined) {
  return new IndexerWebhookSignatureVerifierService({
    get: jest.fn().mockReturnValue(secret),
  } as unknown as ConfigService);
}

describe('IndexerWebhookSignatureVerifierService', () => {
  const service = verifierWith(SECRET);

  it('acepta un cuerpo firmado con el secreto configurado', () => {
    expect(service.verify(BODY, sign(BODY), nowInSeconds())).toBe(true);
  });

  it('rechaza una firma calculada con otro secreto', () => {
    expect(service.verify(BODY, sign(BODY, 'otro'), nowInSeconds())).toBe(
      false,
    );
  });

  it('rechaza el cuerpo alterado después de firmar', () => {
    const tampered = Buffer.from('{"jobId":"abc","state":"indexed"}');

    expect(service.verify(tampered, sign(BODY), nowInSeconds())).toBe(false);
  });

  it('rechaza una entrega fuera de la ventana de tolerancia', () => {
    const tenMinutesAgo = String(Math.floor(Date.now() / 1000) - 600);

    expect(service.verify(BODY, sign(BODY), tenMinutesAgo)).toBe(false);
  });

  it.each([
    ['la firma', BODY, undefined, nowInSeconds()],
    ['el timestamp', BODY, sign(BODY), undefined],
    ['el cuerpo', undefined, sign(BODY), nowInSeconds()],
  ])('rechaza cuando falta %s', (_, rawBody, signature, timestamp) => {
    expect(service.verify(rawBody, signature, timestamp)).toBe(false);
  });

  it('rechaza todo si INDEXER_WEBHOOK_SECRET no está configurado', () => {
    expect(
      verifierWith(undefined).verify(BODY, sign(BODY), nowInSeconds()),
    ).toBe(false);
  });
});
