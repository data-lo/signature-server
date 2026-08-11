import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SealClientService } from './seal-client.service';
import { DocumentSealEntity } from './entities/document-seal.entity';
import { CollaboratorEntity } from 'src/document/entities/collaborator.entity';
import { SIGNATURE_TYPE_ENUM } from 'src/document/enum/signature-type.enum';

const CERTIFICATE = {
  rfc: 'AAA010101AAA',
  name: 'ANA LOPEZ',
  serialNumber: '000010000',
  certificateNumber: '20001000000300000123',
  certificatePem: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
};

function buildCollaborator(overrides: Partial<CollaboratorEntity> = {}) {
  return {
    id: 'collaborator-1',
    documentId: 'doc-1',
    signatureType: SIGNATURE_TYPE_ENUM.FIEL,
    advancedSignature: {
      originalHash: 'hash-original',
      signatureBase64: 'ZmlybWE=',
      algorithm: 'sha256',
      signedAt: new Date('2026-08-11T18:00:00.000Z'),
      certificate: CERTIFICATE,
    },
    ...overrides,
  } as CollaboratorEntity;
}

const SEAL_RESPONSE = {
  documentId: 'doc-1',
  hashHex: 'abc123',
  timeStamp: { fileBase64: 'dHNy' },
  nom151: { file: 'bm9t', pdfFile: 'cGRm' },
};

describe('SealClientService', () => {
  let service: SealClientService;
  let documentSealRepository: Record<string, jest.Mock>;
  let collaboratorRepository: Record<string, jest.Mock>;
  let config: Record<string, jest.Mock>;
  let fetchMock: jest.Mock;

  const env: Record<string, string | undefined> = {
    SEAL_SERVICE_BASE_URL: 'https://seal.example.com',
    SEAL_SERVICE_API_KEY: 'llave-secreta',
  };

  beforeEach(async () => {
    documentSealRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row) => row),
      save: jest.fn((row) => Promise.resolve({ id: 'seal-1', ...row })),
    };
    collaboratorRepository = {
      find: jest.fn().mockResolvedValue([buildCollaborator()]),
    };
    config = { get: jest.fn((key: string) => env[key]) };

    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SEAL_RESPONSE),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SealClientService,
        { provide: ConfigService, useValue: config },
        {
          provide: getRepositoryToken(DocumentSealEntity),
          useValue: documentSealRepository,
        },
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
      ],
    }).compile();

    service = module.get<SealClientService>(SealClientService);
  });

  it('manda documentId, originalHash y el arreglo de firmas al endpoint del Seal Service', async () => {
    await service.sealDocumentSignatures('doc-1', 'hash-original');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://seal.example.com/seal/signature');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      documentId: 'doc-1',
      originalHash: 'hash-original',
      signatures: [
        {
          signatureBase64: 'ZmlybWE=',
          algorithm: 'sha256',
          signedAt: '2026-08-11T18:00:00.000Z',
          certificate: CERTIFICATE,
        },
      ],
    });
  });

  it('autentica con la API key en el header x-api-key', async () => {
    await service.sealDocumentSignatures('doc-1', 'hash-original');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-api-key']).toBe('llave-secreta');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('manda TODAS las firmas avanzadas en un solo arreglo, no una llamada por firmante', async () => {
    collaboratorRepository.find.mockResolvedValue([
      buildCollaborator(),
      buildCollaborator({ id: 'collaborator-2' }),
      buildCollaborator({ id: 'collaborator-3' }),
    ]);

    await service.sealDocumentSignatures('doc-1', 'hash-original');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).signatures).toHaveLength(
      3,
    );
  });

  it('excluye a los colaboradores sin evidencia avanzada (firma simple o aún sin firmar)', async () => {
    collaboratorRepository.find.mockResolvedValue([
      buildCollaborator(),
      buildCollaborator({
        id: 'collaborator-simple',
        signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
        advancedSignature: null,
      }),
    ]);

    await service.sealDocumentSignatures('doc-1', 'hash-original');

    const { signatures } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(signatures).toHaveLength(1);
  });

  it('almacena la respuesta completa del Seal Service junto con el hashHex', async () => {
    const saved = await service.sealDocumentSignatures('doc-1', 'hash-original');

    expect(documentSealRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        hashHex: 'abc123',
        response: SEAL_RESPONSE,
      }),
    );
    expect(saved?.hashHex).toBe('abc123');
  });

  it('es idempotente: si el documento ya tiene sello, no vuelve a llamar al servicio', async () => {
    documentSealRepository.findOne.mockResolvedValue({
      id: 'seal-1',
      documentId: 'doc-1',
      hashHex: 'previo',
    });

    const result = await service.sealDocumentSignatures('doc-1', 'hash');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(documentSealRepository.save).not.toHaveBeenCalled();
    expect(result?.hashHex).toBe('previo');
  });

  it('sin firmas avanzadas no llama al servicio', async () => {
    collaboratorRepository.find.mockResolvedValue([
      buildCollaborator({ advancedSignature: null }),
    ]);

    const result = await service.sealDocumentSignatures('doc-1', 'hash');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it.each([
    ['sin base URL', { SEAL_SERVICE_BASE_URL: undefined }],
    ['sin API key', { SEAL_SERVICE_API_KEY: undefined }],
  ])(
    'si la integración no está configurada (%s), omite el sellado sin romper la firma',
    async (_caso, override) => {
      config.get.mockImplementation(
        (key: string) => ({ ...env, ...override })[key],
      );

      const result = await service.sealDocumentSignatures('doc-1', 'hash');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toBeNull();
    },
  );

  it('propaga un error cuando el Seal Service responde con fallo, sin guardar nada', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve('bad gateway'),
    });

    await expect(
      service.sealDocumentSignatures('doc-1', 'hash'),
    ).rejects.toThrow(/respondió 502/);
    expect(documentSealRepository.save).not.toHaveBeenCalled();
  });

  it('normaliza la URL cuando la base trae diagonal final', async () => {
    config.get.mockImplementation(
      (key: string) =>
        ({ ...env, SEAL_SERVICE_BASE_URL: 'https://seal.example.com/' })[key],
    );

    await service.sealDocumentSignatures('doc-1', 'hash');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://seal.example.com/seal/signature',
    );
  });
});
