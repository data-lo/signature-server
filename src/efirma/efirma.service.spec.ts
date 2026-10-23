import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate, createVerify } from 'node:crypto';

import { EfirmaService } from './efirma.service';
import { CertificateValidationApiService } from './certificate-validation/certificate-validation-api.service';
import {
  CadenaConfianzaInvalidaException,
  CertificadoRevocadoException,
  CertificateValidationServiceUnavailableException,
  LLaveNoCorrespondeCertificadoException,
  LLavePrivadaInvalidException,
} from './efirma.exceptions';
import { CertificateValidationResult } from './interfaces/certificate-validation-result.interface';

/**
 * `__fixtures__` trae un certificado autofirmado con la forma de uno de e.firma (RFC en
 * `x500UniqueIdentifier`) y su llave cifrada en DER PKCS#8 con la contraseña `secreto123`, más una
 * llave ajena. No son del SAT: la cadena de confianza ya no se valida aquí sino en Certificate
 * Validation Service, que se sustituye por un doble.
 */
const FIXTURES_DIR = join(__dirname, '__fixtures__');
const cerBuffer = readFileSync(join(FIXTURES_DIR, 'signer.cer'));
const keyBuffer = readFileSync(join(FIXTURES_DIR, 'signer.key'));
const otherKeyBuffer = readFileSync(join(FIXTURES_DIR, 'other.key'));
const PASSWORD = 'secreto123';
const document = Buffer.from('%PDF-1.7 documento de prueba');

const ocspEvidence = {
  status: 'good' as const,
  verifiedAt: new Date('2026-09-17T18:00:00.000Z'),
  ocspResponse: 'b2NzcA==',
  ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
};

function validationResult(
  overrides: Partial<CertificateValidationResult> = {},
): CertificateValidationResult {
  return {
    serialNumber: '01',
    validity: {
      notBefore: new Date('2026-01-01'),
      notAfter: new Date('2100-01-01'),
      evaluatedAt: new Date(),
    },
    trustChain: { issuer: 'CN=AC', root: 'CN=Raiz' },
    revocation: { status: 'GOOD', checkedAt: ocspEvidence.verifiedAt },
    ocspEvidence,
    ...overrides,
  };
}

describe('EfirmaService', () => {
  let validateCertificate: jest.Mock;
  let service: EfirmaService;

  beforeEach(() => {
    validateCertificate = jest.fn().mockResolvedValue(validationResult());
    service = new EfirmaService({
      validateCertificate,
    } as unknown as CertificateValidationApiService);
  });

  describe('firmar', () => {
    it('firma con la llave y devuelve los datos públicos del certificado y la evidencia OCSP', async () => {
      const result = await service.firmar(
        document,
        cerBuffer,
        keyBuffer,
        PASSWORD,
      );

      const isValidSignature = createVerify('RSA-SHA256')
        .update(document)
        .verify(
          new X509Certificate(cerBuffer).publicKey,
          Buffer.from(result.signatureBase64, 'base64'),
        );
      expect(isValidSignature).toBe(true);
      expect(result.certificate).toMatchObject({
        rfc: 'XAXX010101000',
        name: 'PRUEBA FIRMANTE',
      });
      expect(result.ocspEvidence).toEqual(ocspEvidence);
    });

    it('valida el certificado tolerando que el SAT no responda', async () => {
      await service.firmar(document, cerBuffer, keyBuffer, PASSWORD);

      expect(validateCertificate).toHaveBeenCalledWith(cerBuffer, {
        allowUnverifiedRevocation: true,
      });
    });

    it('firma SIN ocspEvidence cuando el SAT no respondió, para dejar el documento pendiente de sellar', async () => {
      validateCertificate.mockResolvedValue(
        validationResult({
          revocation: { status: 'UNVERIFIED', checkedAt: new Date() },
          ocspEvidence: undefined,
        }),
      );

      const result = await service.firmar(
        document,
        cerBuffer,
        keyBuffer,
        PASSWORD,
      );

      expect(result.signatureBase64).toEqual(expect.any(String));
      expect(result).not.toHaveProperty('ocspEvidence');
    });

    it.each([
      ['revocado', new CertificadoRevocadoException()],
      ['con cadena inválida', new CadenaConfianzaInvalidaException()],
      [
        'sin poder validarse (microservicio caído)',
        new CertificateValidationServiceUnavailableException(),
      ],
    ])(
      'no firma ni toca la llave privada si el certificado está %s',
      async (_, error) => {
        validateCertificate.mockRejectedValue(error);
        const decrypt = jest.spyOn(service, 'descifrarLlavePrivada');

        await expect(
          service.firmar(document, cerBuffer, keyBuffer, PASSWORD),
        ).rejects.toBe(error);
        expect(decrypt).not.toHaveBeenCalled();
      },
    );

    it('rechaza una contraseña incorrecta', async () => {
      await expect(
        service.firmar(document, cerBuffer, keyBuffer, 'otra'),
      ).rejects.toBeInstanceOf(LLavePrivadaInvalidException);
    });

    it('rechaza una llave que no corresponde al certificado', async () => {
      await expect(
        service.firmar(document, cerBuffer, otherKeyBuffer, PASSWORD),
      ).rejects.toBeInstanceOf(LLaveNoCorrespondeCertificadoException);
    });
  });
});
