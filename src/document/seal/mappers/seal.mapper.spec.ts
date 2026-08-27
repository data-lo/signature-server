import { SealMapper } from './seal.mapper';
import { SealDocumentDto } from '../dto/seal-document.dto';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';

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
        issuer: 'SERVICIO DE ADMINISTRACION TRIBUTARIA',
        serialNumber: '00001000000512345678',
        certificateNumber: '30001000000500003416',
        certificatePem: 'pem',
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

describe('SealMapper', () => {
  it('guarda el hash sellado y su preimagen: la cadena canónica que devolvió el proveedor', () => {
    // Es lo que hace verificable el sello sin reimplementar la canonicalización de Seal Service:
    // sha256(canonicalPayload) tiene que dar signatureHash.
    const entity = SealMapper.toEntity(DTO, RESPONSE);

    expect(entity.signatureHash).toBe('abc123');
    expect(entity.canonicalPayload).toBe('v1||13:hash-original|5:doc-1');
  });

  it('la versión del algoritmo queda embebida en lo persistido, así que no se pierde', () => {
    const entity = SealMapper.toEntity(DTO, RESPONSE);

    expect(entity.canonicalPayload).toContain(RESPONSE.hashVersion);
  });

  it('ancla la evidencia al documentId propio, no al que venga en la respuesta', () => {
    const entity = SealMapper.toEntity(DTO, {
      ...RESPONSE,
      documentId: 'otro-documento',
    });

    expect(entity.documentId).toBe('doc-1');
  });

  it('separa el sello de tiempo (TSA) de la constancia de integridad (NOM-151)', () => {
    const entity = SealMapper.toEntity(DTO, RESPONSE);

    expect(entity.timestampEvidence).toEqual({
      isValid: true,
      processedHash: 'abc123',
      fileBase64: 'tsr-en-base64',
      evidenceId: 'ts-uuid',
      issuedAt: new Date('2026-08-13T19:00:00.000Z'),
    });
    expect(entity.integrityEvidence).toEqual({
      isValid: true,
      processedHash: 'abc123',
      fileBase64: 'nom151-en-base64',
      evidenceId: 'nom-uuid',
      issuedAt: new Date('2026-08-13T19:00:00.000Z'),
      certificatePdfBase64: 'pdf-en-base64',
    });
  });
});
