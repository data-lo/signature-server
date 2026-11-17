import {
  WEBHOOK_URL_REJECTION_REASON_ENUM as REASON,
  WebhookUrlNotAllowedException,
} from '../exceptions/outbound-webhook.exceptions';
import { WebhookEndpointUrlPolicy } from './webhook-endpoint-url-policy.service';

/** El motivo de rechazo de una URL, o `null` si se acepta. */
async function rejectionOf(
  policy: WebhookEndpointUrlPolicy,
  url: string,
): Promise<string | null> {
  try {
    await policy.assertAllowed(url);
    return null;
  } catch (error) {
    if (!(error instanceof WebhookUrlNotAllowedException)) throw error;
    const body = error.getResponse() as {
      code: string;
      details: { field: string; reason: string };
    };
    expect(body.code).toBe('WEBHOOK_URL_NOT_ALLOWED');
    expect(body.details.field).toBe('url');
    return body.details.reason;
  }
}

describe('WebhookEndpointUrlPolicy', () => {
  let policy: WebhookEndpointUrlPolicy;
  let resolve: jest.SpyInstance;

  beforeEach(() => {
    policy = new WebhookEndpointUrlPolicy();
    resolve = jest
      .spyOn(policy, 'resolve')
      .mockResolvedValue(['93.184.216.34', '2606:2800:220:1::1']);
  });

  it('acepta https a un host público y normaliza la URL', async () => {
    await expect(
      policy.assertAllowed(
        'https://ERP.Cliente.com:443/webhooks/firmalo?x=1#frag',
      ),
    ).resolves.toBe('https://erp.cliente.com/webhooks/firmalo?x=1');
    expect(resolve).toHaveBeenCalledWith('erp.cliente.com');
  });

  it.each([
    ['no-es-una-url', REASON.INVALID_URL],
    ['http://erp.cliente.com/hook', REASON.HTTPS_REQUIRED],
    ['ftp://erp.cliente.com/hook', REASON.HTTPS_REQUIRED],
    ['https://erp.cliente.com:8443/hook', REASON.PORT_NOT_ALLOWED],
    ['https://user:pass@erp.cliente.com/hook', REASON.CREDENTIALS_NOT_ALLOWED],
    ['https://localhost/hook', REASON.HOST_NOT_ALLOWED],
    ['https://api.localhost/hook', REASON.HOST_NOT_ALLOWED],
    ['https://metadata.google.internal/hook', REASON.HOST_NOT_ALLOWED],
    ['https://servidor/hook', REASON.HOST_NOT_ALLOWED],
    ['https://127.0.0.1/hook', REASON.HOST_NOT_ALLOWED],
    ['https://0x7f000001/hook', REASON.HOST_NOT_ALLOWED],
    ['https://10.1.2.3/hook', REASON.HOST_NOT_ALLOWED],
    ['https://172.20.0.5/hook', REASON.HOST_NOT_ALLOWED],
    ['https://192.168.1.10/hook', REASON.HOST_NOT_ALLOWED],
    ['https://169.254.169.254/latest/meta-data', REASON.HOST_NOT_ALLOWED],
    ['https://100.64.0.1/hook', REASON.HOST_NOT_ALLOWED],
    ['https://[::1]/hook', REASON.HOST_NOT_ALLOWED],
    ['https://[fd00:ec2::254]/hook', REASON.HOST_NOT_ALLOWED],
    ['https://[fe80::1]/hook', REASON.HOST_NOT_ALLOWED],
    ['https://[::ffff:127.0.0.1]/hook', REASON.HOST_NOT_ALLOWED],
  ])('rechaza %s (%s)', async (url, reason) => {
    await expect(rejectionOf(policy, url)).resolves.toBe(reason);
  });

  it('rechaza un nombre público que resuelve a una IP privada', async () => {
    resolve.mockResolvedValue(['93.184.216.34', '10.0.0.7']);

    await expect(
      rejectionOf(policy, 'https://rebind.cliente.com/hook'),
    ).resolves.toBe(REASON.HOST_NOT_ALLOWED);
  });

  it('acepta una IP pública literal sin resolver DNS', async () => {
    await expect(
      policy.assertAllowed('https://93.184.216.34/hook'),
    ).resolves.toBe('https://93.184.216.34/hook');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('propaga el rechazo de un host que no resuelve', async () => {
    resolve.mockRestore();

    await expect(
      rejectionOf(policy, 'https://no-existe.invalid-tld-firmalo-test/hook'),
    ).resolves.toBe(REASON.HOST_NOT_RESOLVABLE);
  });
});
