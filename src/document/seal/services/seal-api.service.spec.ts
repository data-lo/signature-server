import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { SealApiService } from './seal-api.service';
import { SealDocumentDto } from '../dto/seal-document.dto';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';
import {
  SealProviderConfigurationException,
  SealProviderResponseException,
  SealProviderTimeoutException,
  SealProviderUnavailableException,
} from '../exceptions/seal.exceptions';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const SEAL_CONFIG: Record<string, string> = {
  SEAL_SERVICE_URL: 'http://seal-service:3002',
  SEAL_SERVICE_API_KEY: 'api-key-de-prueba',
};

const DTO: SealDocumentDto = {
  documentId: '2b3d9c2e-6d4a-4f6f-9f4e-0b9f1d2a3c4d',
  originalHash: 'hash-original',
  signatures: [
    {
      signatureBase64: 'firma-en-base64',
      algorithm: 'sha256',
      signedAt: '2026-08-13T18:45:56.000Z',
      certificate: {
        rfc: 'PEAJ800101XXX',
        name: 'JUAN PEREZ',
        issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
        serialNumber: '00001000000512345678',
        certificateNumber: '30001000000500003416',
        certificatePem:
          '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
      },
    },
  ],
};

const RESPONSE: SealDocumentResponse = {
  documentId: DTO.documentId,
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

/** Reproduce la forma que `axios.isAxiosError` reconoce, sin depender de la red. */
function axiosError(partial: { status?: number; code?: string } = {}): unknown {
  return {
    isAxiosError: true,
    code: partial.code,
    response: partial.status ? { status: partial.status } : undefined,
    message: 'fallo simulado',
  };
}

describe('SealApiService', () => {
  let service: SealApiService;
  let configValues: Record<string, string>;

  beforeEach(async () => {
    jest.clearAllMocks();
    configValues = { ...SEAL_CONFIG };
    mockedAxios.isAxiosError.mockImplementation(
      (error: unknown): error is never =>
        Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SealApiService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => configValues[key]) },
        },
      ],
    }).compile();

    service = module.get(SealApiService);
  });

  it('manda el arreglo de firmas con el documentId y autentica con la API key en x-api-key', async () => {
    mockedAxios.post.mockResolvedValue({ data: RESPONSE });

    const result = await service.generateDocumentSeals(DTO);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://seal-service:3002/seal/signature',
      DTO,
      expect.objectContaining({
        headers: { 'x-api-key': 'api-key-de-prueba' },
      }),
    );
    expect(result).toEqual(RESPONSE);
  });

  it('normaliza la barra final de SEAL_SERVICE_URL para no armar una ruta con doble slash', async () => {
    configValues.SEAL_SERVICE_URL = 'http://seal-service:3002/';
    mockedAxios.post.mockResolvedValue({ data: RESPONSE });

    await service.generateDocumentSeals(DTO);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://seal-service:3002/seal/signature',
      expect.anything(),
      expect.anything(),
    );
  });

  it('sin configuración, falla con un error explícito y sin llegar a llamar al proveedor', async () => {
    configValues = {};

    await expect(service.generateDocumentSeals(DTO)).rejects.toBeInstanceOf(
      SealProviderConfigurationException,
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('traduce un error HTTP del proveedor a SealProviderResponseException', async () => {
    mockedAxios.post.mockRejectedValue(axiosError({ status: 401 }));

    await expect(service.generateDocumentSeals(DTO)).rejects.toBeInstanceOf(
      SealProviderResponseException,
    );
  });

  it('traduce un timeout a SealProviderTimeoutException', async () => {
    mockedAxios.post.mockRejectedValue(axiosError({ code: 'ECONNABORTED' }));

    await expect(service.generateDocumentSeals(DTO)).rejects.toBeInstanceOf(
      SealProviderTimeoutException,
    );
  });

  it('traduce un fallo de conexión a SealProviderUnavailableException', async () => {
    mockedAxios.post.mockRejectedValue(axiosError({ code: 'ECONNREFUSED' }));

    await expect(service.generateDocumentSeals(DTO)).rejects.toBeInstanceOf(
      SealProviderUnavailableException,
    );
  });

  it.each([['hashHex'], ['canonicalString'], ['timeStamp'], ['nom151']])(
    'rechaza la respuesta si le falta %s, en vez de dejar que reviente después como error de constraint',
    async (missingField) => {
      // Todos estos terminan en columnas NOT NULL de document_seals: sin esta comprobación, una
      // respuesta incompleta falla más tarde, como un error de Postgres que no dice nada del
      // origen real. `canonicalString` además es lo único que permite reconstruir el hash sellado.
      const incomplete = { ...RESPONSE };
      delete incomplete[missingField as keyof SealDocumentResponse];
      mockedAxios.post.mockResolvedValue({ data: incomplete });

      await expect(service.generateDocumentSeals(DTO)).rejects.toBeInstanceOf(
        SealProviderResponseException,
      );
    },
  );

  it('detecta un cambio de contrato del proveedor (p. ej. que renombre hashHex) en vez de guardar un hash vacío', async () => {
    const { hashHex, ...sinHashHex } = RESPONSE;
    mockedAxios.post.mockResolvedValue({
      data: { ...sinHashHex, signHashHex: hashHex },
    });

    await expect(service.generateDocumentSeals(DTO)).rejects.toBeInstanceOf(
      SealProviderResponseException,
    );
  });
});
