import { QueryFailedError } from 'typeorm';

import { BUCKET_TYPES_ENUM } from 'src/common/minio/enums/bucket-types.enum';

import { SEALING_TYPE_ENUM } from '../enums/sealing-type.enum';
import {
  IncompleteSimpleSignatureDataException,
  SealPersistenceException,
  SealProviderUnavailableException,
} from '../exceptions/seal.exceptions';
import { SealDocumentResponse } from '../interfaces/seal-document-response.interface';
import {
  SEALING_REQUEST_SNAPSHOT_VERSION,
  SimpleSealingRequestSnapshot,
} from '../interfaces/sealing-request-snapshot.interface';
import { SendCompletedSimpleSignatureToSealUseCase } from './send-completed-simple-signature-to-seal.use-case';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rubrica'),
]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('ine-cara'),
]);

const SNAPSHOT: SimpleSealingRequestSnapshot = {
  version: SEALING_REQUEST_SNAPSHOT_VERSION,
  sealType: SEALING_TYPE_ENUM.SIMPLE,
  documentId: 'doc-1',
  originalHash: 'hash-original',
  signedHash: 'hash-firmado',
  frozenAt: '2026-11-19T17:00:00.000Z',
  signatures: [
    {
      collaboratorId: 'c-1',
      curp: 'PEAJ800101HDFRRN09',
      email: 'firmante@correo.example',
      name: 'Juan',
      lastName: 'Pérez',
      signedAt: '2026-11-19T16:59:00.000Z',
      verificationData: {
        code: '123456',
        verificationMethod: 'EMAIL_OTP',
        usedAt: '2026-11-19T16:58:00.000Z',
      },
      signatureImageObjectKey: 'snapshots/rubrica-c-1.png',
      identityDocumentFrontImageKey: 'ine/front-c-1',
      identityDocumentBackImageKey: 'ine/back-c-1',
    },
  ],
};

const RESPONSE: SealDocumentResponse = {
  documentId: 'doc-1',
  hashHex: 'abc123',
  hashAlgorithm: 'sha256',
  hashVersion: 'v1',
  canonicalString: 'v1||canonical',
  sealedAt: '2026-11-19T17:05:00.000Z',
  timeStamp: {
    status: true,
    hashProcessed: 'abc123',
    fileBase64: 'tsr',
    uuid: 'ts-uuid',
  },
  nom151: {
    status: true,
    hashProcessed: 'abc123',
    file: 'nom',
    uuid: 'nom-uuid',
    pdfFile: 'pdf',
  },
};

function queryFailedError(code: string): QueryFailedError {
  return new QueryFailedError('INSERT INTO document_seals', [], {
    code,
  } as unknown as Error);
}

describe('SendCompletedSimpleSignatureToSealUseCase', () => {
  let sealRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOneBy: jest.Mock;
  };
  let minioService: {
    getFileInBytesFormat: jest.Mock;
    getSensitiveObject: jest.Mock;
  };
  let sealApiService: { sendSimpleSignatures: jest.Mock };
  let useCase: SendCompletedSimpleSignatureToSealUseCase;

  beforeEach(() => {
    sealRepository = {
      create: jest.fn((data) => data),
      save: jest.fn(async (data) => ({ id: 'seal-1', ...data })),
      findOneBy: jest.fn(),
    };
    minioService = {
      getFileInBytesFormat: jest.fn().mockResolvedValue(PNG),
      // Copia nueva en cada llamada: el caso de uso borra los bytes al terminar.
      getSensitiveObject: jest.fn(async () => Buffer.from(JPEG)),
    };
    sealApiService = {
      sendSimpleSignatures: jest.fn().mockResolvedValue(RESPONSE),
    };
    useCase = new SendCompletedSimpleSignatureToSealUseCase(
      sealRepository as never,
      minioService as never,
      sealApiService as never,
    );
  });

  /** Lo que se envió, capturado antes de que el caso de uso suelte las imágenes de la INE. */
  function captureSentDto(): { current: unknown } {
    const sent: { current: unknown } = { current: null };
    sealApiService.sendSimpleSignatures.mockImplementation(async (dto) => {
      sent.current = JSON.parse(JSON.stringify(dto));
      return RESPONSE;
    });
    return sent;
  }

  it('envía la identidad, el código y las fechas congeladas, no las del perfil actual', async () => {
    const sent = captureSentDto();

    await useCase.execute(SNAPSHOT);

    expect(sent.current).toEqual({
      documentId: 'doc-1',
      originalHash: 'hash-original',
      signedHash: 'hash-firmado',
      signatures: [
        {
          curp: 'PEAJ800101HDFRRN09',
          email: 'firmante@correo.example',
          name: 'Juan',
          lastName: 'Pérez',
          signedAt: '2026-11-19T16:59:00.000Z',
          verificationData: {
            code: '123456',
            verificationMethod: 'EMAIL_OTP',
            usedAt: '2026-11-19T16:58:00.000Z',
          },
          signatureMedia: {
            signatureImage: PNG.toString('base64'),
            identityDocumentFrontImage: JPEG.toString('base64'),
            identityDocumentBackImage: JPEG.toString('base64'),
          },
        },
      ],
    });
  });

  it('descarga la rúbrica y la INE por las llaves congeladas', async () => {
    await useCase.execute(SNAPSHOT);

    expect(minioService.getFileInBytesFormat).toHaveBeenCalledWith(
      'snapshots/rubrica-c-1.png',
      BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
    );
    expect(minioService.getSensitiveObject).toHaveBeenCalledWith(
      BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
      'ine/front-c-1',
    );
    expect(minioService.getSensitiveObject).toHaveBeenCalledWith(
      BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
      'ine/back-c-1',
    );
  });

  it('suelta las imágenes de la INE después del envío, aunque falle', async () => {
    let sentDto: { signatures: { signatureMedia: Record<string, string> }[] } =
      { signatures: [] };
    sealApiService.sendSimpleSignatures.mockImplementation(async (dto) => {
      sentDto = dto;
      throw new SealProviderUnavailableException();
    });

    await expect(useCase.execute(SNAPSHOT)).rejects.toBeInstanceOf(
      SealProviderUnavailableException,
    );
    expect(
      sentDto.signatures[0].signatureMedia.identityDocumentFrontImage,
    ).toBe('');
    expect(sentDto.signatures[0].signatureMedia.identityDocumentBackImage).toBe(
      '',
    );
  });

  it('persiste la constancia con el mapper común', async () => {
    const seal = await useCase.execute(SNAPSHOT);

    expect(seal).toEqual(
      expect.objectContaining({
        id: 'seal-1',
        documentId: 'doc-1',
        signatureHash: 'abc123',
      }),
    );
  });

  it('una violación de unicidad relee la constancia existente', async () => {
    sealRepository.save.mockRejectedValue(queryFailedError('23505'));
    sealRepository.findOneBy.mockResolvedValue({ id: 'seal-previo' });

    await expect(useCase.execute(SNAPSHOT)).resolves.toEqual({
      id: 'seal-previo',
    });
    expect(sealRepository.findOneBy).toHaveBeenCalledWith({
      documentId: 'doc-1',
    });
  });

  /** Fallo de persistencia tras una respuesta exitosa del proveedor: no se disimula con `null`. */
  it('cualquier otro error al guardar se propaga como SealPersistenceException', async () => {
    sealRepository.save.mockRejectedValue(queryFailedError('57P01'));

    await expect(useCase.execute(SNAPSHOT)).rejects.toBeInstanceOf(
      SealPersistenceException,
    );
    expect(sealRepository.findOneBy).not.toHaveBeenCalled();
  });

  it('una rúbrica congelada que ya no es PNG se rechaza sin llamar al proveedor', async () => {
    minioService.getFileInBytesFormat.mockResolvedValue(Buffer.from('jpeg?'));

    await expect(useCase.execute(SNAPSHOT)).rejects.toBeInstanceOf(
      IncompleteSimpleSignatureDataException,
    );
    expect(sealApiService.sendSimpleSignatures).not.toHaveBeenCalled();
  });

  it('una INE almacenada que no es imagen se rechaza sin llamar al proveedor', async () => {
    minioService.getSensitiveObject.mockResolvedValue(Buffer.from('texto'));

    await expect(useCase.execute(SNAPSHOT)).rejects.toThrow(/firmante c-1/);
    expect(sealApiService.sendSimpleSignatures).not.toHaveBeenCalled();
  });
});
