import { getCertStatus } from 'easy-ocsp';

import {
  CertificadoRevocadoException,
  OCSPInvalidResponseException,
  OCSPNotAvailableException,
} from '../efirma.exceptions';
import { OscpService } from './oscp.service';

jest.mock('easy-ocsp', () => ({ getCertStatus: jest.fn() }));

const mockedGetCertStatus = getCertStatus as jest.Mock;
const CERT = Buffer.from('certificado');
const ISSUER = { raw: Buffer.from('emisor') } as never;

describe('OscpService', () => {
  const service = new OscpService();

  beforeEach(() => mockedGetCertStatus.mockReset());

  it.each(['good', 'unknown'])(
    'devuelve la evidencia %s con la respuesta firmada y la hora de la consulta',
    async (status) => {
      mockedGetCertStatus.mockResolvedValue({
        status,
        rawResponse: Buffer.from('respuesta-der'),
      });
      const before = Date.now();

      const evidence = await service.verifyRevokedOCSP(CERT, ISSUER);

      expect(evidence).toEqual({
        status,
        verifiedAt: expect.any(Date),
        ocspResponse: Buffer.from('respuesta-der').toString('base64'),
        ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
      });
      expect(evidence.verifiedAt.getTime()).toBeGreaterThanOrEqual(before);
    },
  );

  it('revocado: CertificadoRevocadoException', async () => {
    mockedGetCertStatus.mockResolvedValue({
      status: 'revoked',
      revocationTime: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(
      service.verifyRevokedOCSP(CERT, ISSUER),
    ).rejects.toBeInstanceOf(CertificadoRevocadoException);
  });

  it('sin respuesta del SAT: OCSPNotAvailableException', async () => {
    mockedGetCertStatus.mockRejectedValue(new Error('timeout'));

    await expect(
      service.verifyRevokedOCSP(CERT, ISSUER),
    ).rejects.toBeInstanceOf(OCSPNotAvailableException);
  });

  it('respuesta sin cuerpo firmado: inválida, ya no una evidencia vacía', async () => {
    mockedGetCertStatus.mockResolvedValue({ status: 'good' });

    await expect(
      service.verifyRevokedOCSP(CERT, ISSUER),
    ).rejects.toBeInstanceOf(OCSPInvalidResponseException);
  });

  it('estado inesperado: inválida', async () => {
    mockedGetCertStatus.mockResolvedValue({
      status: 'otro',
      rawResponse: Buffer.from('x'),
    });

    await expect(
      service.verifyRevokedOCSP(CERT, ISSUER),
    ).rejects.toBeInstanceOf(OCSPInvalidResponseException);
  });
});
