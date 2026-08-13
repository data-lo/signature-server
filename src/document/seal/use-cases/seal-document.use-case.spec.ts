import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';

import { SealDocumentUseCase } from './seal-document.use-case';
import { SealApiService } from '../services/seal-api.service';
import { SealEntity } from '../entities/seal.entity';
import { SealDocumentDto } from '../dto/seal-document.dto';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';
import {
  DocumentAlreadySealedException,
  SealPersistenceException,
  SealProviderUnavailableException,
} from '../exceptions/seal.exceptions';

const DTO: SealDocumentDto = {
  documentId: 'doc-1',
  originalHash: 'hash-original',
  signatures: [
    {
      signatureBase64: 'firma-en-base64',
      algorithm: 'sha256',
      signedAt: '2026-08-13T18:45:56.000Z',
      certificate: {
        rfc: 'PEAJ800101XXX',
        name: 'JUAN PEREZ',
        serialNumber: '00001000000512345678',
        certificateNumber: '30001000000500003416',
        certificatePem: 'pem',
      },
    },
  ],
};

const PROVIDER_RESPONSE: SealDocumentResponse = {
  documentId: 'doc-1',
  hashHex: 'abc123',
  hashAlgorithm: 'sha256',
  hashVersion: 'v1',
  canonicalString: 'v1||13:hash-original|5:doc-1',
  sealedAt: '2026-08-13T19:00:00.000Z',
  timeStamp: {
    status: true,
    hashProcessed: 'abc123',
    fileBase64: 'tsr-en-base64',
    uuid: 'ts-uuid',
  },
  nom151: {
    status: true,
    hashProcessed: 'abc123',
    file: 'nom151-en-base64',
    uuid: 'nom-uuid',
    pdfFile: 'pdf-en-base64',
  },
};

/** Error de Postgres tal como lo envuelve TypeORM (lo que ve el use case en tiempo de ejecución). */
function queryFailedError(code: string): QueryFailedError {
  return new QueryFailedError('INSERT INTO document_seals', [], {
    code,
  } as unknown as Error);
}

describe('SealDocumentUseCase', () => {
  let useCase: SealDocumentUseCase;
  let sealApiService: Record<string, jest.Mock>;
  let sealRepository: Record<string, jest.Mock>;

  beforeEach(async () => {
    sealApiService = {
      generateDocumentSeals: jest.fn().mockResolvedValue(PROVIDER_RESPONSE),
    };
    sealRepository = {
      create: jest.fn((data) => data),
      save: jest.fn(async (entity) => ({ id: 'seal-1', ...entity })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SealDocumentUseCase,
        { provide: SealApiService, useValue: sealApiService },
        { provide: getRepositoryToken(SealEntity), useValue: sealRepository },
      ],
    }).compile();

    useCase = module.get(SealDocumentUseCase);
  });

  it('manda las firmas al proveedor y persiste la evidencia que devuelve', async () => {
    const seal = await useCase.create(DTO);

    expect(sealApiService.generateDocumentSeals).toHaveBeenCalledWith(DTO);
    expect(sealRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        signatureHash: 'abc123',
        canonicalPayload: 'v1||13:hash-original|5:doc-1',
        timestampSeal: expect.objectContaining({
          tokenBase64: 'tsr-en-base64',
        }),
        integritySeal: expect.objectContaining({
          tokenBase64: 'nom151-en-base64',
          certificatePdfBase64: 'pdf-en-base64',
        }),
      }),
    );
    expect(seal.id).toBe('seal-1');
  });

  it('si el proveedor falla, no persiste nada y propaga su error tal cual', async () => {
    sealApiService.generateDocumentSeals.mockRejectedValue(
      new SealProviderUnavailableException(),
    );

    await expect(useCase.create(DTO)).rejects.toBeInstanceOf(
      SealProviderUnavailableException,
    );
    expect(sealRepository.save).not.toHaveBeenCalled();
  });

  it('traduce la violación de unicidad de document_id a DocumentAlreadySealedException', async () => {
    // 23505 = unique_violation. La restricción UQ_document_seals_document_id es lo que garantiza
    // que un documento no acumule evidencias distintas para el mismo conjunto de firmas.
    sealRepository.save.mockRejectedValue(queryFailedError('23505'));

    await expect(useCase.create(DTO)).rejects.toBeInstanceOf(
      DocumentAlreadySealedException,
    );
  });

  it('cualquier otro fallo de base de datos se reporta como error de persistencia, no como duplicado', async () => {
    sealRepository.save.mockRejectedValue(queryFailedError('23503'));

    await expect(useCase.create(DTO)).rejects.toBeInstanceOf(
      SealPersistenceException,
    );
  });

  it('un error que no viene de la base de datos tampoco se confunde con un duplicado', async () => {
    sealRepository.save.mockRejectedValue(new Error('disco lleno'));

    await expect(useCase.create(DTO)).rejects.toBeInstanceOf(
      SealPersistenceException,
    );
  });
});
