import { createHash } from 'crypto';

import { buildDocumentAuditXml } from './audit-xml.builder';
import type { DocumentAuditXmlData } from './audit-xml.types';
import {
  computeVerificationRecordDigest,
  VERIFICATION_RECORD_DIGEST_PATTERN,
} from './verification-record-digest.util';

/** Evidencia mínima pero completa: el digest se calcula sobre el XML real, no sobre un texto suelto. */
function evidence(): DocumentAuditXmlData {
  return {
    document: {
      id: 'doc-1',
      fileName: 'contrato.pdf',
      mimeType: 'application/pdf',
      status: 'signed',
      totalPages: 3,
      originalHash: 'hash-original',
      signedHash: 'hash-firmado',
      signedAt: '2026-01-14T09:00:00.000Z',
    },
    files: [
      {
        role: 'finalized',
        bucket: 'finalized_documents',
        objectKey: 'key.pdf',
        mimeType: 'application/pdf',
        contentBase64: 'RklOQUw=',
      },
    ],
    seal: {
      signatureHash: 'hash-sello',
      timestampEvidenceBase64: 'VFNS',
      nom151EvidenceBase64: 'Tk9NMTUx',
      nom151CertificatePdfBase64: null,
      sealedAt: '2026-01-14T09:05:00.000Z',
    },
    signers: [],
  };
}

describe('computeVerificationRecordDigest', () => {
  it('es el SHA-256 en hexadecimal de los bytes UTF-8 del XML', () => {
    const xml = buildDocumentAuditXml(evidence());

    expect(computeVerificationRecordDigest(xml)).toBe(
      createHash('sha256').update(Buffer.from(xml, 'utf8')).digest('hex'),
    );
  });

  it('coincide con el vector conocido de SHA-256', () => {
    expect(computeVerificationRecordDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('tiene 64 caracteres hexadecimales en minúsculas', () => {
    const digest = computeVerificationRecordDigest(
      buildDocumentAuditXml(evidence()),
    );

    expect(digest).toHaveLength(64);
    expect(digest).toMatch(VERIFICATION_RECORD_DIGEST_PATTERN);
  });

  it('da el mismo digest al volver a generar el XML con la misma evidencia', () => {
    const first = computeVerificationRecordDigest(
      buildDocumentAuditXml(evidence()),
    );
    const second = computeVerificationRecordDigest(
      buildDocumentAuditXml(evidence()),
    );

    expect(second).toBe(first);
  });

  it('cambia al modificar cualquier byte del XML', () => {
    const xml = buildDocumentAuditXml(evidence());
    const original = computeVerificationRecordDigest(xml);
    const bytes = Buffer.from(xml, 'utf8');

    // Cada posición del archivo, con un solo bit invertido.
    for (let index = 0; index < bytes.length; index++) {
      const tampered = Buffer.from(bytes);
      tampered[index] ^= 0x01;

      const digest = createHash('sha256').update(tampered).digest('hex');
      expect(digest).not.toBe(original);
    }

    // Y a nivel de texto: un carácter distinto en la evidencia.
    expect(
      computeVerificationRecordDigest(xml.replace('hash-sello', 'hash-sellO')),
    ).not.toBe(original);
  });

  it('cambia si cambia la evidencia, aunque sea un campo', () => {
    const changed = evidence();
    changed.seal!.sealedAt = '2026-01-14T09:05:00.001Z';

    expect(
      computeVerificationRecordDigest(buildDocumentAuditXml(changed)),
    ).not.toBe(
      computeVerificationRecordDigest(buildDocumentAuditXml(evidence())),
    );
  });

  it('no depende del momento: el XML sin generatedAt no lleva fechas de generación', () => {
    const xml = buildDocumentAuditXml(evidence());

    expect(xml).not.toContain('generatedAt');
    expect(xml).not.toContain('createdAt');
  });
});
