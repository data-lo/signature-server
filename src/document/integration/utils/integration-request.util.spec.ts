import {
  IdempotencyKeyRequiredException,
  TenantOverrideNotAllowedException,
} from '../exceptions/integration-document.exceptions';
import {
  assertNoTenantOverrides,
  buildRequestFingerprint,
  readIdempotencyKey,
} from './integration-request.util';

const VALID_PAYLOAD = {
  creator: { email: 'ana@cliente.com', firstName: 'Ana', lastName: 'López' },
  document: { signatureType: 'SIMPLE' },
  participants: [
    {
      role: 'SIGNER',
      firstName: 'Luis',
      lastName: 'M',
      email: 'luis@correo.com',
    },
  ],
};

function withPayload(patch: (payload: Record<string, any>) => void) {
  const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
  patch(payload);
  return { body: { payload: JSON.stringify(payload) } };
}

describe('integration-request.util', () => {
  describe('assertNoTenantOverrides', () => {
    it('deja pasar una petición sin campos de tenant', () => {
      expect(() =>
        assertNoTenantOverrides({
          headers: { 'x-api-key': 'fma_live_…' },
          query: {},
          body: { payload: JSON.stringify(VALID_PAYLOAD) },
        }),
      ).not.toThrow();
    });

    it.each([
      ['organizationId en el query', { query: { organizationId: 'org-2' } }],
      ['X-Account-Id', { headers: { 'x-account-id': 'acc-2' } }],
      ['X-Organization-Id', { headers: { 'x-organization-id': 'org-2' } }],
      [
        'documentBase64 como campo multipart',
        { body: { documentBase64: 'JVBERi0x' } },
      ],
      [
        'organizationId en el payload',
        withPayload((p) => (p.organizationId = 'org-2')),
      ],
      [
        'permissionIds en el payload',
        withPayload((p) => (p.permissionIds = ['perm'])),
      ],
      [
        'documentBase64 en el payload',
        withPayload((p) => (p.documentBase64 = 'JVBERi0x')),
      ],
      ['userId en creator', withPayload((p) => (p.creator.userId = 'user-2'))],
      [
        'accountId en creator',
        withPayload((p) => (p.creator.accountId = 'acc-2')),
      ],
      [
        'createdBy en document',
        withPayload((p) => (p.document.createdBy = 'user-2')),
      ],
      ['taxId en document', withPayload((p) => (p.document.taxId = 'RFC'))],
      [
        'userId en un participante',
        withPayload((p) => (p.participants[0].userId = 'u')),
      ],
    ])('rechaza %s', (_label, request) => {
      expect(() => assertNoTenantOverrides(request)).toThrow(
        TenantOverrideNotAllowedException,
      );
    });

    it('un payload que no es JSON no rompe la revisión: lo rechaza la validación', () => {
      expect(() =>
        assertNoTenantOverrides({ body: { payload: '{no es json' } }),
      ).not.toThrow();
    });
  });

  describe('readIdempotencyKey', () => {
    it('acepta un valor visible y le quita los espacios', () => {
      expect(readIdempotencyKey('  erp-pedido-8841 ')).toBe('erp-pedido-8841');
    });

    it.each([undefined, '', '   ', 'con espacio', 'x'.repeat(256), 'ñandú'])(
      'rechaza %p',
      (value) => {
        expect(() => readIdempotencyKey(value)).toThrow(
          IdempotencyKeyRequiredException,
        );
      },
    );
  });

  describe('buildRequestFingerprint', () => {
    const body = { payload: JSON.stringify(VALID_PAYLOAD) };

    it('es la misma para el mismo archivo y payload', () => {
      expect(
        buildRequestFingerprint({ buffer: Buffer.from('%PDF-1') }, body),
      ).toBe(
        buildRequestFingerprint({ buffer: Buffer.from('%PDF-1') }, { ...body }),
      );
      expect(
        buildRequestFingerprint({ buffer: Buffer.from('%PDF-1') }, body),
      ).toMatch(/^[0-9a-f]{64}$/);
    });

    it('cambia con otro archivo o con otro payload', () => {
      const base = buildRequestFingerprint(
        { buffer: Buffer.from('%PDF-1') },
        body,
      );

      expect(
        buildRequestFingerprint({ buffer: Buffer.from('%PDF-2') }, body),
      ).not.toBe(base);
      expect(
        buildRequestFingerprint(
          { buffer: Buffer.from('%PDF-1') },
          withPayload((p) => (p.document.signatureType = 'ADVANCED')).body,
        ),
      ).not.toBe(base);
    });
  });
});
