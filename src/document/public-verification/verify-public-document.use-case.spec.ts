import { Logger } from '@nestjs/common';

import {
  VERIFICATION_ARTIFACT_TYPE_ENUM,
  VERIFICATION_MESSAGES,
  VERIFICATION_STATUS_ENUM,
} from './public-verification.types';
import {
  VERIFICATION_FILE_PROBLEM_ENUM,
  type VerificationFileAnalysis,
} from './verification-file-analyzer';
import { VerifyPublicDocumentUseCase } from './verify-public-document.use-case';

const DIGEST = 'a'.repeat(64);
const DOCUMENT_ID = '7f60c871-daf1-4fea-8f27-c23a5a6fb3e1';
const SIGNED_DOCUMENT = {
  id: DOCUMENT_ID,
  fileName: 'contrato.pdf',
  signedAt: new Date('2026-11-19T12:00:00.000Z'),
};

function xml(
  documentId: string | null = DOCUMENT_ID,
): VerificationFileAnalysis {
  return {
    ok: true,
    artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM.AUDIT_XML,
    digest: DIGEST,
    documentId,
  };
}

const PDF: VerificationFileAnalysis = {
  ok: true,
  artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM.FINAL_DOCUMENT,
  digest: DIGEST,
  documentId: null,
};

describe('VerifyPublicDocumentUseCase', () => {
  let query: Record<string, jest.Mock>;
  let repository: { createQueryBuilder: jest.Mock };
  let useCase: VerifyPublicDocumentUseCase;

  beforeEach(() => {
    query = {};
    for (const method of [
      'select',
      'innerJoin',
      'where',
      'andWhere',
      'orderBy',
    ]) {
      query[method] = jest.fn().mockReturnValue(query);
    }
    query.getOne = jest.fn().mockResolvedValue(null);
    // Documentos con huella del XML registrada para el documentId del archivo.
    query.getCount = jest.fn().mockResolvedValue(0);
    repository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    useCase = new VerifyPublicDocumentUseCase(repository as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('XML con verification_record_digest registrado → VALID con el documento', async () => {
    query.getOne.mockResolvedValue(SIGNED_DOCUMENT);

    const result = await useCase.execute(xml());

    expect(query.innerJoin).toHaveBeenCalledWith(
      expect.anything(),
      'seal',
      'seal.documentId = document.id',
    );
    expect(query.where).toHaveBeenCalledWith(
      'seal.verificationRecordDigest = :digest',
      { digest: DIGEST },
    );
    expect(result).toEqual({
      success: true,
      message: VERIFICATION_MESSAGES.VALID,
      data: {
        status: VERIFICATION_STATUS_ENUM.VALID,
        artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM.AUDIT_XML,
        message: VERIFICATION_MESSAGES.VALID,
        document: {
          id: DOCUMENT_ID,
          fileName: 'contrato.pdf',
          signedAt: '2026-11-19T12:00:00.000Z',
        },
      },
    });
  });

  it('PDF con final_document_digest registrado → VALID', async () => {
    query.getOne.mockResolvedValue(SIGNED_DOCUMENT);

    const { data } = await useCase.execute(PDF);

    expect(query.where).toHaveBeenCalledWith(
      'document.finalDocumentDigest = :digest',
      { digest: DIGEST },
    );
    expect(query.innerJoin).not.toHaveBeenCalled();
    expect(data.status).toBe(VERIFICATION_STATUS_ENUM.VALID);
    expect(data.artifactType).toBe(
      VERIFICATION_ARTIFACT_TYPE_ENUM.FINAL_DOCUMENT,
    );
  });

  it('XML con otro hash y documentId existente → COMPROMISED, sin datos del documento', async () => {
    query.getCount.mockResolvedValue(1);

    const { data } = await useCase.execute(xml());

    expect(query.where).toHaveBeenCalledWith('document.id = :documentId', {
      documentId: DOCUMENT_ID,
    });
    expect(query.andWhere).toHaveBeenCalledWith(
      'seal.verificationRecordDigest IS NOT NULL',
    );
    expect(data).toEqual({
      status: VERIFICATION_STATUS_ENUM.COMPROMISED,
      artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM.AUDIT_XML,
      message: VERIFICATION_MESSAGES.COMPROMISED,
    });
  });

  it('XML de un documento sin huella registrada → NOT_FOUND, no COMPROMISED', async () => {
    // getCount = 0: el documento existe pero se selló antes de la huella (o no se sella).
    const { data } = await useCase.execute(xml());

    expect(data.status).toBe(VERIFICATION_STATUS_ENUM.NOT_FOUND);
  });

  it('XML con otro hash y documentId inexistente → NOT_FOUND', async () => {
    const { data } = await useCase.execute(xml());

    expect(data).toEqual({
      status: VERIFICATION_STATUS_ENUM.NOT_FOUND,
      artifactType: VERIFICATION_ARTIFACT_TYPE_ENUM.AUDIT_XML,
      message: VERIFICATION_MESSAGES.NOT_FOUND,
    });
  });

  it('PDF sin hash registrado → NOT_FOUND, sin buscar por id', async () => {
    const { data } = await useCase.execute(PDF);

    expect(data.status).toBe(VERIFICATION_STATUS_ENUM.NOT_FOUND);
    expect(data.document).toBeUndefined();
    expect(query.getCount).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, VERIFICATION_STATUS_ENUM.UNSUPPORTED_FILE],
    [
      {
        ok: false,
        problem: VERIFICATION_FILE_PROBLEM_ENUM.UNSUPPORTED,
        reason: 'x',
      },
      VERIFICATION_STATUS_ENUM.UNSUPPORTED_FILE,
    ],
    [
      {
        ok: false,
        problem: VERIFICATION_FILE_PROBLEM_ENUM.INVALID,
        reason: 'x',
      },
      VERIFICATION_STATUS_ENUM.INVALID_FILE,
    ],
  ] as const)('%j → %s, sin consultar la base', async (analysis, status) => {
    const { data } = await useCase.execute(
      analysis as VerificationFileAnalysis,
    );

    expect(data).toEqual({ status, message: VERIFICATION_MESSAGES[status] });
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('sólo registra el estado: ni el hash ni el id', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    query.getCount.mockResolvedValue(1);

    await useCase.execute(xml());

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('COMPROMISED');
    expect(logged).not.toContain(DIGEST);
    expect(logged).not.toContain(DOCUMENT_ID);
  });
});
