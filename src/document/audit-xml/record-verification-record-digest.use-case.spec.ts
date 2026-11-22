import { createHash } from 'crypto';

import { SealEntity } from '../seal/entities/seal.entity';
import {
  SealPersistenceException,
  VerificationRecordDigestException,
} from '../seal/exceptions/seal.exceptions';
import { IncompleteAuditEvidenceException } from './audit-xml.exceptions';
import { RecordVerificationRecordDigestUseCase } from './record-verification-record-digest.use-case';

const DOCUMENT_ID = 'doc-1';
const AUDIT_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<documentAudit version="1" documentId="doc-1" />\n';
const EXPECTED_DIGEST = createHash('sha256')
  .update(AUDIT_XML, 'utf8')
  .digest('hex');

describe('RecordVerificationRecordDigestUseCase', () => {
  const seal = { id: 'seal-1', documentId: DOCUMENT_ID } as SealEntity;
  let auditXml: { build: jest.Mock };
  let sealDocument: { persistVerificationRecordDigest: jest.Mock };
  let useCase: RecordVerificationRecordDigestUseCase;

  beforeEach(() => {
    auditXml = { build: jest.fn().mockResolvedValue(AUDIT_XML) };
    sealDocument = {
      persistVerificationRecordDigest: jest.fn().mockResolvedValue(undefined),
    };
    useCase = new RecordVerificationRecordDigestUseCase(
      auditXml as never,
      sealDocument as never,
    );
  });

  it('arma el XML sin generatedAt, con la constancia recibida', async () => {
    await useCase.execute(DOCUMENT_ID, seal);

    expect(auditXml.build).toHaveBeenCalledWith(DOCUMENT_ID, { seal });
    const [, options] = auditXml.build.mock.calls[0];
    expect(options).not.toHaveProperty('generatedAt');
  });

  it('guarda en la constancia el SHA-256 hex del XML', async () => {
    const digest = await useCase.execute(DOCUMENT_ID, seal);

    expect(digest).toBe(EXPECTED_DIGEST);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sealDocument.persistVerificationRecordDigest).toHaveBeenCalledWith(
      'seal-1',
      EXPECTED_DIGEST,
    );
  });

  it('guarda el mismo digest si se repite con la misma evidencia', async () => {
    const first = await useCase.execute(DOCUMENT_ID, seal);
    const second = await useCase.execute(DOCUMENT_ID, seal);

    expect(second).toBe(first);
    expect(
      sealDocument.persistVerificationRecordDigest.mock.calls.map(
        ([, digest]) => digest,
      ),
    ).toEqual([EXPECTED_DIGEST, EXPECTED_DIGEST]);
  });

  it('guarda otro digest si el XML cambió en un byte', async () => {
    auditXml.build.mockResolvedValue(AUDIT_XML.replace('doc-1', 'doc-2'));

    const digest = await useCase.execute(DOCUMENT_ID, seal);

    expect(digest).not.toBe(EXPECTED_DIGEST);
  });

  it('no guarda nada y lanza un error reintentable si el XML no se puede armar', async () => {
    auditXml.build.mockRejectedValue(
      new IncompleteAuditEvidenceException('el PDF firmado', DOCUMENT_ID),
    );

    await expect(useCase.execute(DOCUMENT_ID, seal)).rejects.toThrow(
      VerificationRecordDigestException,
    );
    expect(sealDocument.persistVerificationRecordDigest).not.toHaveBeenCalled();
  });

  it('lanza el error reintentable si el digest no se puede guardar', async () => {
    sealDocument.persistVerificationRecordDigest.mockRejectedValue(
      new SealPersistenceException(),
    );

    await expect(useCase.execute(DOCUMENT_ID, seal)).rejects.toThrow(
      VerificationRecordDigestException,
    );
  });
});
