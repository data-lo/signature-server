import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { Repository } from 'typeorm';

import { CertificateValidationApiService } from 'src/efirma/certificate-validation/certificate-validation-api.service';
import {
  CertificadoRevocadoException,
  OCSPNotAvailableException,
} from 'src/efirma/efirma.exceptions';
import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { DocumentEntity } from '../../entities/document.entity';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { RetryPendingSealUseCase } from './retry-pending-seal.use-case';

const certificatePem = new X509Certificate(
  readFileSync(
    join(__dirname, '..', '..', '..', 'efirma', '__fixtures__', 'signer.cer'),
  ),
).toString();

const ocspEvidence = {
  status: 'good' as const,
  verifiedAt: new Date('2026-09-17T18:00:00.000Z'),
  ocspResponse: 'b2NzcA==',
  ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
};

describe('RetryPendingSealUseCase', () => {
  let documentRepository: { update: jest.Mock };
  let collaboratorRepository: { find: jest.Mock; update: jest.Mock };
  let validateCertificate: jest.Mock;
  let useCase: RetryPendingSealUseCase;
  let document: DocumentEntity;
  let collaborator: CollaboratorEntity;

  beforeEach(() => {
    document = {
      id: 'doc-1',
      sealingPendingAt: new Date('2026-09-01T00:00:00.000Z'),
    } as DocumentEntity;
    collaborator = {
      id: 'col-1',
      documentId: 'doc-1',
      signatureType: SIGNATURE_TYPE_ENUM.FIEL,
      signedAt: new Date('2026-09-01T10:00:00.000Z'),
      advancedSignature: {
        signatureBase64: 'firma',
        algorithm: 'sha256',
        // Así llega desde la columna jsonb: como cadena, no como Date.
        signedAt: '2026-09-01T10:00:00.000Z' as unknown as Date,
        certificate: {
          rfc: 'XAXX010101000',
          name: 'PRUEBA FIRMANTE',
          issuer: 'Signature Test',
          serialNumber: '01',
          certificateNumber: '1',
          certificatePem,
        },
      },
    } as CollaboratorEntity;

    documentRepository = { update: jest.fn() };
    collaboratorRepository = {
      find: jest.fn().mockResolvedValue([collaborator]),
      update: jest.fn(),
    };
    validateCertificate = jest.fn().mockResolvedValue({ ocspEvidence });

    useCase = new RetryPendingSealUseCase(
      documentRepository as unknown as Repository<DocumentEntity>,
      collaboratorRepository as unknown as Repository<CollaboratorEntity>,
      { validateCertificate } as unknown as CertificateValidationApiService,
    );
  });

  it('valida el certificado guardado en la fecha de la firma, exigiendo respuesta del SAT', async () => {
    await useCase.execute(document);

    const [cerBuffer, options] = validateCertificate.mock.calls[0];
    expect(new X509Certificate(cerBuffer).toString()).toBe(certificatePem);
    expect(options).toEqual({
      referenceDate: new Date('2026-09-01T10:00:00.000Z'),
      allowUnverifiedRevocation: false,
    });
  });

  it('guarda la evidencia y limpia la marca de pendiente', async () => {
    await expect(useCase.execute(document)).resolves.toBe(true);

    expect(collaboratorRepository.update).toHaveBeenCalledWith('col-1', {
      advancedSignature: expect.objectContaining({ ocspEvidence }),
    });
    expect(documentRepository.update).toHaveBeenCalledWith('doc-1', {
      sealingPendingAt: null,
    });
  });

  it.each([
    ['el SAT sigue sin responder', new OCSPNotAvailableException()],
    ['el certificado resultó revocado', new CertificadoRevocadoException()],
  ])('deja el documento pendiente, sin lanzar, si %s', async (_, error) => {
    validateCertificate.mockRejectedValue(error);

    await expect(useCase.execute(document)).resolves.toBe(false);
    expect(collaboratorRepository.update).not.toHaveBeenCalled();
    expect(documentRepository.update).not.toHaveBeenCalled();
  });
});
