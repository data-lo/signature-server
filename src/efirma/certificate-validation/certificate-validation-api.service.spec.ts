import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CadenaConfianzaInvalidaException,
  CertificadoExpiradoException,
  CertificadoInvalidoException,
  CertificadoRevocadoException,
  CertificateValidationServiceUnavailableException,
  OCSPNotAvailableException,
} from '../efirma.exceptions';
import { CertificateValidationApiService } from './certificate-validation-api.service';

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return {
    __esModule: true,
    default: {
      post: jest.fn(),
      isAxiosError: actual.default.isAxiosError,
      AxiosError: actual.default.AxiosError,
    },
  };
});

const post = axios.post as jest.Mock;
const cerBuffer = readFileSync(
  join(__dirname, '..', '__fixtures__', 'signer.cer'),
);

const successBody = {
  isValid: true,
  serialNumber: '01',
  validity: {
    isValid: true,
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2100-01-01T00:00:00.000Z',
    evaluatedAt: '2026-09-17T18:00:00.000Z',
  },
  trustChain: { isValid: true, issuer: 'CN=AC', root: 'CN=Raiz' },
  revocation: { status: 'GOOD', checkedAt: '2026-09-17T18:00:00.000Z' },
  ocspEvidence: {
    status: 'good',
    verifiedAt: '2026-09-17T18:00:00.000Z',
    ocspResponse: 'b2NzcA==',
    ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
  },
};

/** Error de axios con respuesta HTTP, como lo lanza la librería real. */
function httpError(status: number, code?: string) {
  const error = new axios.AxiosError(`Request failed with status ${status}`);
  error.response = {
    status,
    data: code ? { statusCode: status, code, message: 'x' } : 'Bad Gateway',
  } as never;
  return error;
}

describe('CertificateValidationApiService', () => {
  let configValues: Record<string, string | undefined>;
  let service: CertificateValidationApiService;

  beforeEach(() => {
    post.mockReset();
    configValues = {
      CERTIFICATE_VALIDATION_SERVICE_URL: 'http://certificate-validation:3003/',
      CERTIFICATE_VALIDATION_SERVICE_API_KEY: 'api-key-de-prueba',
    };
    service = new CertificateValidationApiService({
      get: (key: string) => configValues[key],
    } as unknown as ConfigService);
  });

  it('envía el certificado en Base64 con la API Key y normaliza la barra final de la URL', async () => {
    post.mockResolvedValue({ data: successBody });

    await service.validateCertificate(cerBuffer, {
      referenceDate: new Date('2026-09-01T00:00:00.000Z'),
      allowUnverifiedRevocation: true,
    });

    expect(post).toHaveBeenCalledWith(
      'http://certificate-validation:3003/api/v1/certificates/validate',
      {
        certificate: cerBuffer.toString('base64'),
        referenceDate: '2026-09-01T00:00:00.000Z',
        allowUnverifiedRevocation: true,
      },
      expect.objectContaining({
        headers: { 'x-api-key': 'api-key-de-prueba' },
      }),
    );
  });

  it('convierte las fechas de la respuesta y la evidencia OCSP a Date', async () => {
    post.mockResolvedValue({ data: successBody });

    const result = await service.validateCertificate(cerBuffer);

    expect(result.ocspEvidence).toEqual({
      status: 'good',
      verifiedAt: new Date('2026-09-17T18:00:00.000Z'),
      ocspResponse: 'b2NzcA==',
      ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
    });
    expect(result.validity.notAfter).toEqual(
      new Date('2100-01-01T00:00:00.000Z'),
    );
  });

  it('omite ocspEvidence cuando el SAT no respondió y se permitió seguir', async () => {
    const { ocspEvidence: _omitted, ...withoutEvidence } = successBody;
    post.mockResolvedValue({
      data: {
        ...withoutEvidence,
        revocation: { ...successBody.revocation, status: 'UNVERIFIED' },
      },
    });

    const result = await service.validateCertificate(cerBuffer, {
      allowUnverifiedRevocation: true,
    });

    expect(result.revocation.status).toBe('UNVERIFIED');
    expect(result).not.toHaveProperty('ocspEvidence');
  });

  it.each([
    ['INVALID_CERTIFICATE', 400, CertificadoInvalidoException],
    ['CERTIFICATE_EXPIRED', 422, CertificadoExpiradoException],
    ['CERTIFICATE_NOT_YET_VALID', 422, CertificadoExpiradoException],
    ['INVALID_TRUST_CHAIN', 422, CadenaConfianzaInvalidaException],
    ['CERTIFICATE_REVOKED', 422, CertificadoRevocadoException],
    ['OCSP_SERVICE_UNAVAILABLE', 503, OCSPNotAvailableException],
    ['INVALID_API_KEY', 401, CertificateValidationServiceUnavailableException],
    ['INVALID_REQUEST', 400, CertificateValidationServiceUnavailableException],
    [
      'CERTIFICATE_VALIDATION_ERROR',
      500,
      CertificateValidationServiceUnavailableException,
    ],
    ['UN_CODIGO_NUEVO', 418, CertificateValidationServiceUnavailableException],
    [undefined, 502, CertificateValidationServiceUnavailableException],
  ])(
    'traduce code=%s (HTTP %s) a %p',
    async (code, status, expectedException) => {
      post.mockRejectedValue(httpError(status, code));

      await expect(
        service.validateCertificate(cerBuffer),
      ).rejects.toBeInstanceOf(expectedException);
    },
  );

  it('usa el fin de vigencia del certificado en el mensaje de CertificadoExpiradoException', async () => {
    post.mockRejectedValue(httpError(422, 'CERTIFICATE_EXPIRED'));

    await expect(service.validateCertificate(cerBuffer)).rejects.toThrow(
      /expiró su vigencia el \d{4}-/,
    );
  });

  it('responde CertificateValidationServiceUnavailableException si no hay conexión', async () => {
    const error = new axios.AxiosError('connect ECONNREFUSED', 'ECONNREFUSED');
    post.mockRejectedValue(error);

    await expect(service.validateCertificate(cerBuffer)).rejects.toBeInstanceOf(
      CertificateValidationServiceUnavailableException,
    );
  });

  it('responde CertificateValidationServiceUnavailableException ante un 200 que no respeta el contrato', async () => {
    post.mockResolvedValue({ data: { isValid: true } });

    await expect(service.validateCertificate(cerBuffer)).rejects.toBeInstanceOf(
      CertificateValidationServiceUnavailableException,
    );
  });

  it.each([
    'CERTIFICATE_VALIDATION_SERVICE_URL',
    'CERTIFICATE_VALIDATION_SERVICE_API_KEY',
  ])('no llama al servicio si falta %s', async (variable) => {
    configValues[variable] = undefined;

    await expect(service.validateCertificate(cerBuffer)).rejects.toBeInstanceOf(
      CertificateValidationServiceUnavailableException,
    );
    expect(post).not.toHaveBeenCalled();
  });
});
