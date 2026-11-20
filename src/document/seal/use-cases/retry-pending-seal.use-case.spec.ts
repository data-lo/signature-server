import {
  CadenaConfianzaInvalidaException,
  CertificadoRevocadoException,
  OCSPInvalidResponseException,
  OCSPNotAvailableException,
} from 'src/efirma/efirma.exceptions';

import { CollaboratorEntity } from '../../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { IncompleteAdvancedSignatureEvidenceException } from '../exceptions/seal.exceptions';
import { RetryPendingSealUseCase } from './retry-pending-seal.use-case';

// El PEM de las pruebas no es un certificado real: basta con que `raw` lleve algo reconocible.
jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  X509Certificate: jest.fn().mockImplementation((pem: string) => {
    if (pem === 'pem-ilegible') {
      throw new Error('not a certificate');
    }
    return { raw: Buffer.from(pem) };
  }),
}));

const SIGNED_AT = '2026-11-19T17:00:00.000Z';

/** Firmante FIEL tal como se relee de la base. */
function fielSigner(
  id: string,
  ocspEvidence: object | undefined,
  certificatePem = `pem-${id}`,
): CollaboratorEntity {
  return {
    id,
    documentId: 'doc-1',
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    signatureType: SIGNATURE_TYPE_ENUM.FIEL,
    advancedSignature: {
      signatureBase64: `firma-${id}`,
      algorithm: 'sha256',
      signedAt: SIGNED_AT,
      certificate: { certificatePem },
      ...(ocspEvidence && { ocspEvidence }),
    },
  } as unknown as CollaboratorEntity;
}

const GOOD = (verifiedAt: string) => ({
  status: 'good',
  verifiedAt,
  ocspResponse: 'respuesta',
  ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
});

describe('RetryPendingSealUseCase', () => {
  let collaboratorRepository: { find: jest.Mock; update: jest.Mock };
  let efirmaService: { validarCadenaConfianza: jest.Mock };
  let ocspService: { verifyRevokedOCSP: jest.Mock };
  let useCase: RetryPendingSealUseCase;

  beforeEach(() => {
    collaboratorRepository = { find: jest.fn(), update: jest.fn() };
    efirmaService = {
      validarCadenaConfianza: jest.fn().mockReturnValue({ raw: 'emisor' }),
    };
    ocspService = { verifyRevokedOCSP: jest.fn() };
    useCase = new RetryPendingSealUseCase(
      collaboratorRepository as never,
      efirmaService as never,
      ocspService as never,
    );
  });

  it('consulta sólo a los firmantes FIEL sin evidencia y sólo con rol SIGNER', async () => {
    collaboratorRepository.find.mockResolvedValue([
      fielSigner('c-1', GOOD(SIGNED_AT)),
    ]);

    await useCase.execute('doc-1');

    expect(collaboratorRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          documentId: 'doc-1',
          colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
        },
      }),
    );
    expect(ocspService.verifyRevokedOCSP).not.toHaveBeenCalled();
    expect(collaboratorRepository.update).not.toHaveBeenCalled();
  });

  /**
   * Varios firmantes con la evidencia parcialmente recuperada: el primero ya la tenía, el segundo
   * la obtiene ahora. Cada respuesta se guarda en cuanto llega y lo devuelto es lo releído.
   */
  it('completa a los que faltan, guarda cada evidencia y devuelve los firmantes recargados', async () => {
    const reloaded = [
      fielSigner('c-1', GOOD(SIGNED_AT)),
      fielSigner('c-2', GOOD('2026-11-19T18:00:00.000Z')),
    ];
    collaboratorRepository.find
      .mockResolvedValueOnce([
        fielSigner('c-1', GOOD(SIGNED_AT)),
        fielSigner('c-2', undefined),
      ])
      .mockResolvedValueOnce(reloaded);
    const evidence = {
      status: 'good',
      verifiedAt: new Date('2026-11-19T18:00:00.000Z'),
      ocspResponse: 'respuesta-nueva',
      ocspUrl: 'https://cfdi.sat.gob.mx/edofiel',
    };
    ocspService.verifyRevokedOCSP.mockResolvedValue(evidence);

    await expect(useCase.execute('doc-1')).resolves.toBe(reloaded);

    expect(ocspService.verifyRevokedOCSP).toHaveBeenCalledTimes(1);
    expect(ocspService.verifyRevokedOCSP).toHaveBeenCalledWith(
      Buffer.from('pem-c-2'),
      { raw: 'emisor' },
    );
    // `verifiedAt` es el de la consulta; `signedAt` sigue siendo el de la firma.
    expect(collaboratorRepository.update).toHaveBeenCalledWith('c-2', {
      advancedSignature: expect.objectContaining({
        signedAt: SIGNED_AT,
        ocspEvidence: evidence,
      }),
    });
  });

  it('si el SAT cae a la mitad, la evidencia de los anteriores ya quedó guardada', async () => {
    collaboratorRepository.find.mockResolvedValueOnce([
      fielSigner('c-1', undefined),
      fielSigner('c-2', undefined),
    ]);
    ocspService.verifyRevokedOCSP
      .mockResolvedValueOnce({ status: 'good', verifiedAt: new Date() })
      .mockRejectedValueOnce(new OCSPNotAvailableException());

    await expect(useCase.execute('doc-1')).rejects.toBeInstanceOf(
      OCSPNotAvailableException,
    );
    expect(collaboratorRepository.update).toHaveBeenCalledTimes(1);
    expect(collaboratorRepository.update).toHaveBeenCalledWith(
      'c-1',
      expect.anything(),
    );
  });

  it('vuelve a preguntar por una evidencia unknown y guarda la respuesta nueva', async () => {
    collaboratorRepository.find
      .mockResolvedValueOnce([
        fielSigner('c-1', { ...GOOD(SIGNED_AT), status: 'unknown' }),
      ])
      .mockResolvedValueOnce([]);
    ocspService.verifyRevokedOCSP.mockResolvedValue({
      status: 'good',
      verifiedAt: new Date(),
    });

    await useCase.execute('doc-1');

    expect(ocspService.verifyRevokedOCSP).toHaveBeenCalledTimes(1);
    expect(collaboratorRepository.update).toHaveBeenCalledWith('c-1', {
      advancedSignature: expect.objectContaining({
        ocspEvidence: expect.objectContaining({ status: 'good' }),
      }),
    });
  });

  it('guarda una respuesta unknown tal cual: decidir si basta es tarea del procesador', async () => {
    collaboratorRepository.find
      .mockResolvedValueOnce([fielSigner('c-1', undefined)])
      .mockResolvedValueOnce([]);
    ocspService.verifyRevokedOCSP.mockResolvedValue({
      status: 'unknown',
      verifiedAt: new Date(),
    });

    await useCase.execute('doc-1');

    expect(collaboratorRepository.update).toHaveBeenCalledWith('c-1', {
      advancedSignature: expect.objectContaining({
        ocspEvidence: expect.objectContaining({ status: 'unknown' }),
      }),
    });
  });

  it.each([
    ['revocado', new CertificadoRevocadoException(new Date('2026-01-01'))],
    ['respuesta inválida', new OCSPInvalidResponseException('sin cuerpo')],
  ])(
    'propaga el error tipado del SAT (%s) sin guardar nada',
    async (_, error) => {
      collaboratorRepository.find.mockResolvedValueOnce([
        fielSigner('c-1', undefined),
      ]);
      ocspService.verifyRevokedOCSP.mockRejectedValue(error);

      await expect(useCase.execute('doc-1')).rejects.toBe(error);
      expect(collaboratorRepository.update).not.toHaveBeenCalled();
    },
  );

  it('propaga una cadena de confianza rota', async () => {
    collaboratorRepository.find.mockResolvedValueOnce([
      fielSigner('c-1', undefined),
    ]);
    efirmaService.validarCadenaConfianza.mockImplementation(() => {
      throw new CadenaConfianzaInvalidaException();
    });

    await expect(useCase.execute('doc-1')).rejects.toBeInstanceOf(
      CadenaConfianzaInvalidaException,
    );
    expect(ocspService.verifyRevokedOCSP).not.toHaveBeenCalled();
  });

  it('un certificado guardado ilegible es evidencia incompleta, no un null', async () => {
    collaboratorRepository.find.mockResolvedValueOnce([
      fielSigner('c-1', undefined, 'pem-ilegible'),
    ]);

    await expect(useCase.execute('doc-1')).rejects.toBeInstanceOf(
      IncompleteAdvancedSignatureEvidenceException,
    );
  });
});
