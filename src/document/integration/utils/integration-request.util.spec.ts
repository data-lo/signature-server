import {
  IdempotencyKeyRequiredException,
  TenantOverrideNotAllowedException,
} from '../exceptions/integration-document.exceptions';
import {
  assertNoTenantOverrides,
  buildRequestFingerprint,
  readIdempotencyKey,
} from './integration-request.util';

describe('integration-request.util', () => {
  describe('assertNoTenantOverrides', () => {
    it('deja pasar una petición sin campos de tenant', () => {
      expect(() =>
        assertNoTenantOverrides({
          headers: { 'x-api-key': 'fma_live_…' },
          query: { page: '1', statuses: 'SIGNED' },
          body: {
            documentData: JSON.stringify({ fileName: 'a.pdf' }),
            // El taxId de un testigo, dentro de collaborators, es un dato legítimo.
            collaborators: JSON.stringify([{ taxId: 'AUDI990101YYY' }]),
          },
        }),
      ).not.toThrow();
    });

    it.each([
      ['organizationId en el query', { query: { organizationId: 'org-2' } }],
      ['accountId en el query', { query: { accountId: 'acc-2' } }],
      ['X-Account-Id', { headers: { 'x-account-id': 'acc-2' } }],
      ['X-Organization-Id', { headers: { 'x-organization-id': 'org-2' } }],
      ['createdBy en el body', { body: { createdBy: 'user-2' } }],
      ['taxId en el body', { body: { taxId: 'RFC' } }],
      [
        'createdByUserId dentro de documentData',
        { body: { documentData: JSON.stringify({ createdByUserId: 'u' }) } },
      ],
      [
        'organizationId dentro de documentData',
        { body: { documentData: JSON.stringify({ organizationId: 'org-2' }) } },
      ],
    ])('rechaza %s', (_label, request) => {
      expect(() => assertNoTenantOverrides(request)).toThrow(
        TenantOverrideNotAllowedException,
      );
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
    const body = {
      documentData: '{"fileName":"a.pdf"}',
      collaborators: '[]',
    };

    it('es la misma para el mismo archivo y payload', () => {
      const file = { buffer: Buffer.from('%PDF-1') };

      expect(buildRequestFingerprint(file, body)).toBe(
        buildRequestFingerprint({ buffer: Buffer.from('%PDF-1') }, { ...body }),
      );
      expect(buildRequestFingerprint(file, body)).toMatch(/^[0-9a-f]{64}$/);
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
          { ...body, collaborators: '[{}]' },
        ),
      ).not.toBe(base);
    });
  });
});
