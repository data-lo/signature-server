import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MinioService } from 'src/common/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';

import { DocumentService } from '../document.service';
import { CollaboratorEntity } from '../entities/collaborator.entity';
import { COLABORATOR_TYPE_ENUM } from '../enum/colaborator-type.enum';
import { DOCUMENT_STATUS_ENUM } from '../enum/document-status.enum';
import { SIGNATURE_TYPE_ENUM } from '../enum/signature-type.enum';
import { COLLABORATOR_STATUS_ENUM } from '../enum/collaborator-status.enum';
import { SealDocumentUseCase } from '../seal/use-cases/seal-document.use-case';
import { GetPublicDocumentAuditXmlUseCase } from './get-public-document-audit-xml.use-case';

const DOCUMENT_ID = 'doc-1';
const FRONT_IMAGE_KEY = 'pi-1/verif-1/front.jpg';
const BACK_IMAGE_KEY = 'pi-1/verif-1/back.png';

/** Cabeceras reales de cada formato: el `mimeType` del XML se detecta por los bytes. */
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02];
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03];
const FRONT_BASE64 = Buffer.from(JPEG_BYTES).toString('base64');
const BACK_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

function signedDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOCUMENT_ID,
    objectKey: 'key.pdf',
    fileName: 'contrato.pdf',
    fileType: 'application/pdf',
    status: DOCUMENT_STATUS_ENUM.SIGNED,
    totalPages: 3,
    originalHash: 'hash-original',
    signedHash: 'hash-firmado',
    signedAt: new Date('2026-01-14T09:00:00.000Z'),
    ...overrides,
  };
}

function simpleSigner(overrides: Partial<CollaboratorEntity> = {}) {
  return {
    id: 'col-1',
    documentId: DOCUMENT_ID,
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
    status: COLLABORATOR_STATUS_ENUM.SIGNED,
    signedAt: new Date('2026-01-14T08:30:00.000Z'),
    ipAddress: '10.0.0.2',
    geolocation: { latitude: 19.43, longitude: -99.13 },
    email: null,
    advancedSignature: null,
    signatureSnapshotObjectKey: 'rubrica.png',
    account: {
      user: {
        email: 'firmante@example.com',
        nationalId: 'CURPDELREGISTRO001',
        personalInformation: {
          curp: 'CURPCANONICA000001',
          frontImageKey: FRONT_IMAGE_KEY,
          backImageKey: BACK_IMAGE_KEY,
        },
        signature: { signatureObjectKey: 'rubrica-perfil.png' },
      },
    },
    ...overrides,
  } as unknown as CollaboratorEntity;
}

describe('GetPublicDocumentAuditXmlUseCase', () => {
  let useCase: GetPublicDocumentAuditXmlUseCase;
  /** Lo que devuelve la consulta de firmantes en cada prueba. */
  let signers: CollaboratorEntity[];
  let signersQuery: Record<string, jest.Mock>;
  let collaboratorRepository: { createQueryBuilder: jest.Mock };
  let documentService: { findOne: jest.Mock };
  let minioService: {
    getFileInBytesFormat: jest.Mock;
    getSensitiveObject: jest.Mock;
    uploadPdfAObject: jest.Mock;
    uploadObject: jest.Mock;
  };
  let sealDocument: { findByDocumentId: jest.Mock };

  /** Cada bucket devuelve un contenido distinto, para poder afirmar qué copia entró en qué nodo. */
  const storedFiles: Record<string, string> = {
    [BUCKET_TYPES_ENUM.CREATED_DOCUMENTS]: 'ORIGINAL',
    [BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS]: 'FIRMADO',
    [BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS]: 'FINAL',
    [BUCKET_TYPES_ENUM.SIGNATURE_IMAGES]: 'PNG',
  };

  beforeEach(async () => {
    signers = [];
    signersQuery = {};
    for (const method of [
      'leftJoinAndSelect',
      'addSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
    ]) {
      signersQuery[method] = jest.fn().mockReturnValue(signersQuery);
    }
    signersQuery.getMany = jest.fn(() => Promise.resolve(signers));
    collaboratorRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(signersQuery),
    };
    documentService = {
      findOne: jest.fn().mockResolvedValue(signedDocument()),
    };
    minioService = {
      getFileInBytesFormat: jest
        .fn()
        .mockImplementation((_key: string, bucket: BUCKET_TYPES_ENUM) =>
          Promise.resolve(Buffer.from(storedFiles[bucket])),
        ),
      // Un Buffer nuevo por llamada: el caso de uso pone en cero los bytes de la INE al terminar.
      getSensitiveObject: jest
        .fn()
        .mockImplementation((_bucket: BUCKET_TYPES_ENUM, key: string) =>
          Promise.resolve(
            Buffer.from(key === FRONT_IMAGE_KEY ? JPEG_BYTES : PNG_BYTES),
          ),
        ),
      uploadPdfAObject: jest.fn(),
      uploadObject: jest.fn(),
    };
    sealDocument = { findByDocumentId: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetPublicDocumentAuditXmlUseCase,
        {
          provide: getRepositoryToken(CollaboratorEntity),
          useValue: collaboratorRepository,
        },
        { provide: DocumentService, useValue: documentService },
        { provide: MinioService, useValue: minioService },
        { provide: SealDocumentUseCase, useValue: sealDocument },
      ],
    }).compile();

    useCase = module.get(GetPublicDocumentAuditXmlUseCase);
  });

  it('responde el XML como descarga con tipo application/xml', async () => {
    const result = await useCase.execute(DOCUMENT_ID);

    expect(result.contentType).toBe('application/xml');
    expect(result.fileName).toBe(`auditoria-${DOCUMENT_ID}.xml`);
    expect(result.content.toString('utf-8')).toContain('<documentAudit');
  });

  it('incluye los tres PDFs del expediente en Base64', async () => {
    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(xml).toContain(`bucket="created_documents"`);
    expect(xml).toContain(`>${Buffer.from('ORIGINAL').toString('base64')}<`);
    expect(xml).toContain(`>${Buffer.from('FIRMADO').toString('base64')}<`);
    expect(xml).toContain(`>${Buffer.from('FINAL').toString('base64')}<`);
  });

  /**
   * El criterio central de la historia: el XML se arma bajo demanda y no se guarda. Si alguna vez
   * alguien agrega un `upload` "para no regenerarlo", esta prueba lo detiene.
   */
  it('no escribe nada en MinIO al generar el archivo', async () => {
    await useCase.execute(DOCUMENT_ID);

    expect(minioService.uploadPdfAObject).not.toHaveBeenCalled();
    expect(minioService.uploadObject).not.toHaveBeenCalled();
  });

  it('rechaza el documento que todavía no está firmado', async () => {
    documentService.findOne.mockResolvedValue(
      signedDocument({ status: DOCUMENT_STATUS_ENUM.PENDING_SIGNATURE }),
    );

    await expect(useCase.execute(DOCUMENT_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(minioService.getFileInBytesFormat).not.toHaveBeenCalled();
  });

  it('responde un error controlado si falta un PDF obligatorio', async () => {
    minioService.getFileInBytesFormat.mockImplementation(
      (_key: string, bucket: BUCKET_TYPES_ENUM) =>
        bucket === BUCKET_TYPES_ENUM.CREATED_DOCUMENTS
          ? Promise.reject(new Error('El archivo no existe en el bucket'))
          : Promise.resolve(Buffer.from(storedFiles[bucket])),
    );

    await expect(useCase.execute(DOCUMENT_ID)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  /**
   * El definitivo se incluye "cuando aplique": su ausencia se anota en el archivo, no tumba la
   * descarga — a diferencia del original y el firmado, sin los cuales no habría qué auditar.
   */
  it('anota el PDF definitivo ausente sin romper la descarga', async () => {
    minioService.getFileInBytesFormat.mockImplementation(
      (_key: string, bucket: BUCKET_TYPES_ENUM) =>
        bucket === BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS
          ? Promise.reject(new Error('El archivo no existe en el bucket'))
          : Promise.resolve(Buffer.from(storedFiles[bucket])),
    );

    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(xml).toContain('role="finalized"');
    expect(xml).toContain('available="false"');
  });

  it('incluye el sello sin la cadena canónica cuando el documento se selló', async () => {
    sealDocument.findByDocumentId.mockResolvedValue({
      signatureHash: 'hash-sello',
      canonicalPayload: '12|cadena||34|canonica',
      timestampEvidence: { fileBase64: 'VFNS' },
      integrityEvidence: {
        fileBase64: 'Tk9NMTUx',
        certificatePdfBase64: 'UERG',
      },
      sealedAt: new Date('2026-01-14T09:05:00.000Z'),
    });

    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(xml).not.toContain('canonicalPayload');
    expect(xml).not.toContain('12|cadena||34|canonica');
    expect(xml).toContain('>VFNS</timestampEvidence>');
    expect(xml).toContain('>Tk9NMTUx</nom151Evidence>');
    expect(xml).toContain('>hash-sello</signatureHash>');
  });

  it('sigue generando el XML de un documento sin constancia', async () => {
    sealDocument.findByDocumentId.mockRejectedValue(new Error('sin sello'));

    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(xml).toContain('<seal available="false"');
  });

  it('descarga la rúbrica del snapshot del firmante de firma simple', async () => {
    signers = [simpleSigner()];

    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(minioService.getFileInBytesFormat).toHaveBeenCalledWith(
      'rubrica.png',
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
    expect(xml).toContain(`>${Buffer.from('PNG').toString('base64')}<`);
    expect(xml).toContain('>firmante@example.com</email>');
    // La CURP canónica de `personal_information` manda sobre la copia del registro.
    expect(xml).toContain('>CURPCANONICA000001</curp>');
    expect(xml).toContain('latitude="19.43"');
  });

  it('cae a la CURP del registro cuando no hay información personal', async () => {
    signers = [
      simpleSigner({
        account: {
          user: {
            email: 'firmante@example.com',
            nationalId: 'CURPDELREGISTRO001',
            personalInformation: null,
            signature: null,
          },
        },
      } as unknown as Partial<CollaboratorEntity>),
    ];

    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(xml).toContain('>CURPDELREGISTRO001</curp>');
  });

  /**
   * Una llave que apunta a un objeto ilegible es evidencia rota, no un dato que nunca existió: el
   * expediente no puede salir omitiendo la rúbrica en silencio.
   */
  it('responde un error controlado si la rúbrica registrada no se puede leer', async () => {
    signers = [simpleSigner()];
    minioService.getFileInBytesFormat.mockImplementation(
      (_key: string, bucket: BUCKET_TYPES_ENUM) =>
        bucket === BUCKET_TYPES_ENUM.SIGNATURE_IMAGES
          ? Promise.reject(new Error('El archivo no existe en el bucket'))
          : Promise.resolve(Buffer.from(storedFiles[bucket])),
    );

    await expect(useCase.execute(DOCUMENT_ID)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('anota al firmante que nunca registró una rúbrica, sin fallar', async () => {
    signers = [
      simpleSigner({
        signatureSnapshotObjectKey: null,
        account: {
          user: {
            email: 'firmante@example.com',
            nationalId: 'CURPDELREGISTRO001',
            personalInformation: { curp: 'CURPCANONICA000001' },
            signature: null,
          },
        },
      } as unknown as Partial<CollaboratorEntity>),
    ];

    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(xml).toContain('El firmante no tiene una rúbrica registrada.');
  });

  it('incluye advanced_signature completo y ninguna rúbrica para e.firma', async () => {
    signers = [
      simpleSigner({
        signatureType: SIGNATURE_TYPE_ENUM.FIEL,
        advancedSignature: {
          signatureBase64: 'RklSTUE=',
          algorithm: 'sha256',
          signedAt: '2026-01-14T08:00:00.000Z',
          certificate: { rfc: 'AAA010101AAA', serialNumber: '00001' },
          ocspEvidence: { status: 'good' },
        },
      } as unknown as Partial<CollaboratorEntity>),
    ];

    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(xml).toContain('<advancedSignature>');
    expect(xml).toContain('>RklSTUE=</signatureBase64>');
    expect(xml).toContain('>AAA010101AAA</rfc>');
    expect(xml).toContain('>good</status>');
    expect(xml).not.toContain('<simpleSignature>');
    expect(xml).not.toContain('identityDocument');
    expect(minioService.getFileInBytesFormat).not.toHaveBeenCalledWith(
      expect.anything(),
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
    expect(minioService.getSensitiveObject).not.toHaveBeenCalled();
  });

  it('incluye la INE de Didit en signatureMedia con el mimeType real de cada cara', async () => {
    signers = [simpleSigner()];

    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(minioService.getSensitiveObject).toHaveBeenCalledWith(
      BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
      FRONT_IMAGE_KEY,
    );
    expect(minioService.getSensitiveObject).toHaveBeenCalledWith(
      BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
      BACK_IMAGE_KEY,
    );
    expect(xml).toMatch(
      /<signatureMedia>\s*<signatureImage [^>]*>[^<]*<\/signatureImage>\s*<identityDocumentFrontImage /,
    );
    expect(xml).toContain(
      `<identityDocumentFrontImage encoding="base64" mimeType="image/jpeg" available="true">${FRONT_BASE64}</identityDocumentFrontImage>`,
    );
    expect(xml).toContain(
      `<identityDocumentBackImage encoding="base64" mimeType="image/png" available="true">${BACK_BASE64}</identityDocumentBackImage>`,
    );
    // La llave de MinIO de un documento de identidad no se publica.
    expect(xml).not.toContain(FRONT_IMAGE_KEY);
    expect(xml).not.toContain(BACK_IMAGE_KEY);
  });

  it('declara la cara de la INE que Didit no entregó y genera el XML igual', async () => {
    signers = [
      simpleSigner({
        account: {
          user: {
            email: 'firmante@example.com',
            nationalId: 'CURPDELREGISTRO001',
            personalInformation: {
              curp: 'CURPCANONICA000001',
              frontImageKey: FRONT_IMAGE_KEY,
              backImageKey: null,
            },
            signature: null,
          },
        },
      } as unknown as Partial<CollaboratorEntity>),
    ];

    const xml = (await useCase.execute(DOCUMENT_ID)).content.toString('utf-8');

    expect(xml).toContain(
      '<identityDocumentBackImage encoding="base64" available="false" unavailableReason="El firmante no tiene la imagen trasera de la INE verificada por Didit." />',
    );
    expect(xml).toContain(`>${FRONT_BASE64}</identityDocumentFrontImage>`);
    expect(minioService.getSensitiveObject).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no se puede leer', () => Promise.reject(new Error('NoSuchKey'))],
    [
      'no es una imagen',
      () => Promise.resolve(Buffer.from('no-soy-una-imagen')),
    ],
  ])(
    'responde un error controlado si la INE registrada %s',
    async (_label, read) => {
      signers = [simpleSigner()];
      minioService.getSensitiveObject.mockImplementation(read);

      await expect(useCase.execute(DOCUMENT_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
    },
  );

  it('pide sólo a los colaboradores firmantes, con las llaves de la INE, en el orden de firma', async () => {
    await useCase.execute(DOCUMENT_ID);

    expect(collaboratorRepository.createQueryBuilder).toHaveBeenCalledWith(
      'collaborator',
    );
    expect(signersQuery.addSelect).toHaveBeenCalledWith([
      'personalInformation.frontImageKey',
      'personalInformation.backImageKey',
    ]);
    expect(signersQuery.where).toHaveBeenCalledWith(
      'collaborator.documentId = :documentId',
      { documentId: DOCUMENT_ID },
    );
    expect(signersQuery.andWhere).toHaveBeenCalledWith(
      'collaborator.colaboratorType = :signerType',
      { signerType: COLABORATOR_TYPE_ENUM.SIGNER },
    );
    expect(signersQuery.orderBy).toHaveBeenCalledWith(
      'collaborator.signingOrder',
      'ASC',
    );
    expect(signersQuery.addOrderBy).toHaveBeenCalledWith(
      'collaborator.createdAt',
      'ASC',
    );
  });
});
