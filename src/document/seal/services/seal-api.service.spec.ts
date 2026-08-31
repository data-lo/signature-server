import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

import { SealApiService } from './seal-api.service';
import { SealDocumentDto } from '../dto/seal-document.dto';
import { SimpleSignatureDTO } from '../dto/simple-signature.dto';
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
      ocspEvidence: {
        status: 'good',
        verifiedAt: '2026-08-13T18:45:56.000Z',
        ocspResponse: 'respuesta-ocsp-en-base64',
        ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
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

/** Documento de firma simple ya completo, con un firmante. */
const SIMPLE_DTO: SimpleSignatureDTO = {
  documentId: '2b3d9c2e-6d4a-4f6f-9f4e-0b9f1d2a3c4d',
  originalHash: 'hash-original',
  signedHash: 'hash-firmado',
  signatures: [
    {
      curp: 'RAMJ850101MDFXXX01',
      email: 'firmante@example.com',
      name: 'Juana',
      lastName: 'Ramírez Soto',
      signedAt: '2026-08-20T15:04:05.000Z',
      verificationData: {
        code: '123456',
        verificationMethod: 'EMAIL_OTP',
        usedAt: '2026-08-20T15:03:00.000Z',
      },
      signatureMedia: { signatureImage: 'iVBORw0KGgo=' },
    },
  ],
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

  describe('firmas simples', () => {
    it('manda el DTO a /seal/simple-signature con la API key y devuelve la constancia', async () => {
      mockedAxios.post.mockResolvedValue({ data: RESPONSE });

      const result = await service.sendSimpleSignatures(SIMPLE_DTO);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://seal-service:3002/seal/simple-signature',
        SIMPLE_DTO,
        expect.objectContaining({
          headers: { 'x-api-key': 'api-key-de-prueba' },
        }),
      );
      expect(result).toEqual(RESPONSE);
    });

    /**
     * Se persiste con el mismo mapper y en las mismas columnas NOT NULL que el sellado avanzado,
     * así que un 200 con cuerpo incompleto tiene que fallar acá y no al guardar, donde
     * `persistSeal` lo confundiría con "la fila ya existía" y dejaría la tabla NOM-151 vacía sin
     * rastro en el log.
     */
    it('rechaza una respuesta incompleta del proveedor', async () => {
      mockedAxios.post.mockResolvedValue({ data: {} });

      await expect(
        service.sendSimpleSignatures(SIMPLE_DTO),
      ).rejects.toBeInstanceOf(SealProviderResponseException);
    });

    it('sin configuración, falla sin llegar a llamar al proveedor', async () => {
      configValues = {};

      await expect(
        service.sendSimpleSignatures(SIMPLE_DTO),
      ).rejects.toBeInstanceOf(SealProviderConfigurationException);
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it.each([
      [
        'un error HTTP',
        axiosError({ status: 500 }),
        SealProviderResponseException,
      ],
      [
        'un timeout',
        axiosError({ code: 'ETIMEDOUT' }),
        SealProviderTimeoutException,
      ],
      [
        'un fallo de conexión',
        axiosError({ code: 'ECONNREFUSED' }),
        SealProviderUnavailableException,
      ],
    ])(
      'traduce %s a su excepción de dominio',
      async (_caso, error, expected) => {
        mockedAxios.post.mockRejectedValue(error);

        await expect(
          service.sendSimpleSignatures(SIMPLE_DTO),
        ).rejects.toBeInstanceOf(expected);
      },
    );

    it('no registra datos personales ni la rúbrica cuando el proveedor falla', async () => {
      const logged: string[] = [];
      const loggerSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
      mockedAxios.post.mockRejectedValue(axiosError({ status: 400 }));

      await expect(service.sendSimpleSignatures(SIMPLE_DTO)).rejects.toThrow();

      const registrado = logged.join(' ');
      expect(registrado).toContain(SIMPLE_DTO.documentId);
      for (const dato of [
        'RAMJ850101MDFXXX01',
        'firmante@example.com',
        'Juana',
        '123456',
        'iVBORw0KGgo=',
      ]) {
        expect(registrado).not.toContain(dato);
      }

      // Se restaura para no dejar silenciado el logger del resto del archivo.
      loggerSpy.mockRestore();
    });
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
