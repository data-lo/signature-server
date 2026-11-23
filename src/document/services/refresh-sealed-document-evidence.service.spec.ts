import { createHash } from 'crypto';

import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';

import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import {
  SealedEvidencePdfUpdateException,
  SignedPdfIntegrityException,
  VerificationRecordDigestException,
} from '../seal/exceptions/seal.exceptions';
import { RefreshSealedDocumentEvidenceService } from './refresh-sealed-document-evidence.service';

const SIGNED_PDF = Buffer.from('%PDF-1.7 firmado');
const SIGNED_HASH = createHash('sha256').update(SIGNED_PDF).digest('hex');
const SEAL = { id: 'seal-1', documentId: 'doc-1' };

describe('RefreshSealedDocumentEvidenceService', () => {
  let documentService: { findOne: jest.Mock; attachSignaturesSheet: jest.Mock };
  let collaboratorRepository: { find: jest.Mock };
  let minioService: { getFileInBytesFormat: jest.Mock };
  let processor: { useEvidenceRefresher: jest.Mock };
  let recordDigest: { execute: jest.Mock };
  let service: RefreshSealedDocumentEvidenceService;
  const signers = [
    { id: 'c-1', invitedEmail: 'a@correo.example' },
    { id: 'c-2', invitedEmail: 'b@correo.example' },
  ];
  const document = {
    id: 'doc-1',
    objectKey: 'doc-1.pdf',
    signedHash: SIGNED_HASH,
  };

  beforeEach(() => {
    documentService = {
      findOne: jest.fn().mockResolvedValue({ ...document }),
      attachSignaturesSheet: jest.fn().mockResolvedValue(undefined),
    };
    collaboratorRepository = { find: jest.fn().mockResolvedValue(signers) };
    minioService = {
      getFileInBytesFormat: jest.fn().mockResolvedValue(SIGNED_PDF),
    };
    processor = { useEvidenceRefresher: jest.fn() };
    recordDigest = { execute: jest.fn().mockResolvedValue('a'.repeat(64)) };
    service = new RefreshSealedDocumentEvidenceService(
      documentService as never,
      collaboratorRepository as never,
      minioService as never,
      {
        generateFileHash: async (b: Buffer) =>
          createHash('sha256').update(b).digest('hex'),
      } as never,
      processor as never,
      recordDigest as never,
    );
  });

  it('se registra en el procesador al arrancar', () => {
    service.onModuleInit();

    expect(processor.useEvidenceRefresher).toHaveBeenCalledWith(service);
  });

  it('arma la hoja con la constancia sobre el PDF firmado, sin la hoja anterior', async () => {
    await service.refresh('doc-1', SEAL as never);

    expect(minioService.getFileInBytesFormat).toHaveBeenCalledWith(
      'doc-1.pdf',
      BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
    );
    expect(collaboratorRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          documentId: 'doc-1',
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      }),
    );
    expect(documentService.attachSignaturesSheet).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-1', signedHash: SIGNED_HASH }),
      signers,
      SIGNED_PDF,
      expect.any(String),
      SEAL,
    );
  });

  it('guarda el digest del XML de auditoría después de publicar el PDF final', async () => {
    await service.refresh('doc-1', SEAL as never);

    expect(recordDigest.execute).toHaveBeenCalledWith('doc-1', SEAL);
    expect(
      documentService.attachSignaturesSheet.mock.invocationCallOrder[0],
    ).toBeLessThan(recordDigest.execute.mock.invocationCallOrder[0]);
  });

  it('no calcula el digest si el PDF final no se pudo publicar', async () => {
    documentService.attachSignaturesSheet.mockRejectedValue(new Error('x'));

    await expect(service.refresh('doc-1', SEAL as never)).rejects.toThrow(
      SealedEvidencePdfUpdateException,
    );
    expect(recordDigest.execute).not.toHaveBeenCalled();
  });

  it('propaga el fallo del digest para que la fase se repita', async () => {
    recordDigest.execute.mockRejectedValue(
      new VerificationRecordDigestException(),
    );

    await expect(service.refresh('doc-1', SEAL as never)).rejects.toThrow(
      VerificationRecordDigestException,
    );
  });

  it('repetirlo parte siempre del mismo PDF base: no acumula hojas', async () => {
    await service.refresh('doc-1', SEAL as never);
    await service.refresh('doc-1', SEAL as never);

    const bases = documentService.attachSignaturesSheet.mock.calls.map(
      (call) => call[2],
    );
    expect(bases).toEqual([SIGNED_PDF, SIGNED_PDF]);
  });

  it('no anexa nada si el PDF firmado ya no tiene el signedHash del documento', async () => {
    minioService.getFileInBytesFormat.mockResolvedValue(
      Buffer.from('otro pdf'),
    );

    await expect(
      service.refresh('doc-1', SEAL as never),
    ).rejects.toBeInstanceOf(SignedPdfIntegrityException);
    expect(documentService.attachSignaturesSheet).not.toHaveBeenCalled();
  });

  it('MinIO caído al leer el PDF firmado es un fallo reintentable del PDF', async () => {
    minioService.getFileInBytesFormat.mockRejectedValue(
      new Error('minio caído'),
    );

    await expect(
      service.refresh('doc-1', SEAL as never),
    ).rejects.toBeInstanceOf(SealedEvidencePdfUpdateException);
  });

  it('un fallo al generar o publicar la hoja es un fallo reintentable del PDF', async () => {
    documentService.attachSignaturesSheet.mockRejectedValue(
      new Error('Error cargano PDF/A en minio'),
    );

    await expect(
      service.refresh('doc-1', SEAL as never),
    ).rejects.toBeInstanceOf(SealedEvidencePdfUpdateException);
  });
});
