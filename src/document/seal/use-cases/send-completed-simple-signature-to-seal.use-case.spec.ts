import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MinioService } from 'src/shared/minio/minio.service';
import { BUCKET_TYPES_ENUM } from 'src/shared/minio/enums/bucket-types.enum';
import { DocumentEntity } from '../../entities/document.entity';
import { VerificationCodeEntity } from '../../entities/verification-code.entity';
import { COLABORATOR_TYPE_ENUM } from '../../enum/colaborator-type.enum';
import { SIGNATURE_TYPE_ENUM } from '../../enum/signature-type.enum';
import { SIGNEE_STATUS_ENUM } from '../../enum/signee-status.enum';
import { SealApiService } from '../services/seal-api.service';
import { IncompleteSimpleSignatureDataException } from '../exceptions/seal.exceptions';
import { SendCompletedSimpleSignatureToSealUseCase } from './send-completed-simple-signature-to-seal.use-case';

const DOCUMENT_ID = 'doc-1';

/** PNG mínimo: los 8 bytes de la firma del formato más algo de relleno. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('contenido-de-la-rubrica'),
]);

function givenSigner(overrides: Record<string, unknown> = {}) {
  return {
    id: 'collab-1',
    colaboratorType: COLABORATOR_TYPE_ENUM.SIGNER,
    signatureType: SIGNATURE_TYPE_ENUM.SIMPLE,
    status: SIGNEE_STATUS_ENUM.SIGNED,
    signedAt: new Date('2026-08-20T15:04:05.000Z'),
    signatureSnapshotObjectKey: 'snapshot-collab-1.png',
    account: {
      user: {
        email: 'firmante@example.com',
        firstName: 'Juana',
        lastName: 'Ramírez',
        nationalId: 'RAMJ850101MDFXXX01',
        personalInformation: {
          curp: 'RAMJ850101MDFXXX01',
          name: 'Juana',
          lastName: 'Ramírez Soto',
        },
        signature: { signatureObjectKey: 'firma-en-vivo.png' },
      },
    },
    ...overrides,
  };
}

function givenDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOCUMENT_ID,
    originalHash: 'hash-original',
    signedHash: 'hash-firmado',
    collaborators: [givenSigner()],
    ...overrides,
  };
}

describe('SendCompletedSimpleSignatureToSealUseCase', () => {
  let useCase: SendCompletedSimpleSignatureToSealUseCase;
  let documentQueryBuilder: { getOne: jest.Mock };
  let verificationCodeQueryBuilder: { getOne: jest.Mock };
  let minioService: { getFileInBytesFormat: jest.Mock };
  let sealApiService: { sendSimpleSignatures: jest.Mock };

  /**
   * Los `QueryBuilder` se simulan como cadenas donde todo método devuelve el mismo objeto y sólo
   * `getOne` resuelve: lo que se prueba es qué hace el caso de uso con el resultado, no el SQL
   * que TypeORM genera (eso lo cubriría una prueba contra Postgres, no un unitario).
   */
  function chainedBuilder(getOne: jest.Mock): Record<string, unknown> {
    const builder: Record<string, unknown> = { getOne };
    for (const method of [
      'leftJoinAndSelect',
      'where',
      'andWhere',
      'orderBy',
    ]) {
      builder[method] = jest.fn(() => builder);
    }
    return builder;
  }

  beforeEach(async () => {
    documentQueryBuilder = { getOne: jest.fn() };
    verificationCodeQueryBuilder = {
      getOne: jest.fn().mockResolvedValue({
        code: '123456',
        usedAt: new Date('2026-08-20T15:03:00.000Z'),
      }),
    };
    minioService = {
      getFileInBytesFormat: jest.fn().mockResolvedValue(PNG_BYTES),
    };
    sealApiService = {
      sendSimpleSignatures: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SendCompletedSimpleSignatureToSealUseCase,
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: {
            createQueryBuilder: jest.fn(() =>
              chainedBuilder(documentQueryBuilder.getOne),
            ),
          },
        },
        {
          provide: getRepositoryToken(VerificationCodeEntity),
          useValue: {
            createQueryBuilder: jest.fn(() =>
              chainedBuilder(verificationCodeQueryBuilder.getOne),
            ),
          },
        },
        { provide: MinioService, useValue: minioService },
        { provide: SealApiService, useValue: sealApiService },
      ],
    }).compile();

    useCase = module.get(SendCompletedSimpleSignatureToSealUseCase);
  });

  function sentDto(): Record<string, any> {
    return sealApiService.sendSimpleSignatures.mock.calls[0][0];
  }

  describe('documento de firma simple completo', () => {
    beforeEach(() =>
      documentQueryBuilder.getOne.mockResolvedValue(givenDocument()),
    );

    it('envía un DTO con los hashes del documento y una firma por firmante', async () => {
      await expect(useCase.execute(DOCUMENT_ID)).resolves.toBe(true);

      expect(sentDto()).toMatchObject({
        documentId: DOCUMENT_ID,
        originalHash: 'hash-original',
        signedHash: 'hash-firmado',
      });
      expect(sentDto().signatures).toHaveLength(1);
    });

    it('toma los datos personales de la información canónica del usuario', async () => {
      await useCase.execute(DOCUMENT_ID);

      expect(sentDto().signatures[0]).toMatchObject({
        curp: 'RAMJ850101MDFXXX01',
        email: 'firmante@example.com',
        name: 'Juana',
        lastName: 'Ramírez Soto',
      });
    });

    it('manda las fechas en ISO 8601', async () => {
      await useCase.execute(DOCUMENT_ID);

      expect(sentDto().signatures[0].signedAt).toBe('2026-08-20T15:04:05.000Z');
      expect(sentDto().signatures[0].verificationData.usedAt).toBe(
        '2026-08-20T15:03:00.000Z',
      );
    });

    it('incluye el código consumido y el método con el que se entregó', async () => {
      await useCase.execute(DOCUMENT_ID);

      expect(sentDto().signatures[0].verificationData).toEqual({
        code: '123456',
        verificationMethod: 'EMAIL_OTP',
        usedAt: '2026-08-20T15:03:00.000Z',
      });
    });

    it('baja la rúbrica del snapshot inmutable y la manda en Base64', async () => {
      await useCase.execute(DOCUMENT_ID);

      expect(minioService.getFileInBytesFormat).toHaveBeenCalledWith(
        'snapshot-collab-1.png',
        BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
      );
      expect(sentDto().signatures[0].signatureMedia.signatureImage).toBe(
        PNG_BYTES.toString('base64'),
      );
    });

    it('cae a la firma en vivo del perfil cuando la fila no tiene snapshot', async () => {
      documentQueryBuilder.getOne.mockResolvedValue(
        givenDocument({
          collaborators: [givenSigner({ signatureSnapshotObjectKey: null })],
        }),
      );

      await useCase.execute(DOCUMENT_ID);

      expect(minioService.getFileInBytesFormat).toHaveBeenCalledWith(
        'firma-en-vivo.png',
        BUCKET_TYPES_ENUM.SIGNATURE_IMAGES,
      );
    });

    it('omite las imágenes de la INE sin impedir el envío', async () => {
      await useCase.execute(DOCUMENT_ID);

      const media = sentDto().signatures[0].signatureMedia;
      expect(media.identityDocumentFrontImage).toBeUndefined();
      expect(media.identityDocumentBackImage).toBeUndefined();
      expect(media.signatureImage).toEqual(expect.any(String));
    });

    it('arma una firma por cada firmante requerido', async () => {
      documentQueryBuilder.getOne.mockResolvedValue(
        givenDocument({
          collaborators: [
            givenSigner(),
            givenSigner({
              id: 'collab-2',
              signatureSnapshotObjectKey: 'snapshot-collab-2.png',
            }),
          ],
        }),
      );

      await useCase.execute(DOCUMENT_ID);

      expect(sentDto().signatures).toHaveLength(2);
    });

    it('ignora a quien no es firmante', async () => {
      documentQueryBuilder.getOne.mockResolvedValue(
        givenDocument({
          collaborators: [
            givenSigner(),
            {
              id: 'watcher-1',
              colaboratorType: COLABORATOR_TYPE_ENUM.WATCHER,
              status: SIGNEE_STATUS_ENUM.PENDING,
            },
          ],
        }),
      );

      await expect(useCase.execute(DOCUMENT_ID)).resolves.toBe(true);
      expect(sentDto().signatures).toHaveLength(1);
    });
  });

  describe('documentos que no son asunto de este flujo', () => {
    it.each([
      [
        'todavía tiene firmas pendientes',
        givenDocument({
          collaborators: [
            givenSigner(),
            givenSigner({
              id: 'collab-2',
              status: SIGNEE_STATUS_ENUM.PENDING,
            }),
          ],
        }),
      ],
      [
        'es de firma avanzada',
        givenDocument({
          collaborators: [
            givenSigner({ signatureType: SIGNATURE_TYPE_ENUM.FIEL }),
          ],
        }),
      ],
      ['no tiene hash firmado', givenDocument({ signedHash: null })],
      ['no tiene hash original', givenDocument({ originalHash: null })],
      ['no tiene firmantes', givenDocument({ collaborators: [] })],
      ['no existe', null],
    ])('no llama a Seal Service cuando el documento %s', async (_caso, doc) => {
      documentQueryBuilder.getOne.mockResolvedValue(doc);

      await expect(useCase.execute(DOCUMENT_ID)).resolves.toBe(false);
      expect(sealApiService.sendSimpleSignatures).not.toHaveBeenCalled();
    });

    it('trata como firma simple al colaborador sin signature_type (filas previas a FIEL)', async () => {
      documentQueryBuilder.getOne.mockResolvedValue(
        givenDocument({
          collaborators: [givenSigner({ signatureType: null })],
        }),
      );

      await expect(useCase.execute(DOCUMENT_ID)).resolves.toBe(true);
    });
  });

  describe('datos incompletos: no se llama al proveedor', () => {
    it('falta el código de verificación consumido', async () => {
      documentQueryBuilder.getOne.mockResolvedValue(givenDocument());
      verificationCodeQueryBuilder.getOne.mockResolvedValue(null);

      await expect(useCase.execute(DOCUMENT_ID)).rejects.toBeInstanceOf(
        IncompleteSimpleSignatureDataException,
      );
      expect(sealApiService.sendSimpleSignatures).not.toHaveBeenCalled();
    });

    it('el código está registrado pero sin fecha de consumo', async () => {
      documentQueryBuilder.getOne.mockResolvedValue(givenDocument());
      verificationCodeQueryBuilder.getOne.mockResolvedValue({
        code: '123456',
        usedAt: null,
      });

      await expect(useCase.execute(DOCUMENT_ID)).rejects.toBeInstanceOf(
        IncompleteSimpleSignatureDataException,
      );
      expect(sealApiService.sendSimpleSignatures).not.toHaveBeenCalled();
    });

    it('el firmante no tiene ninguna firma PNG a la que apuntar', async () => {
      const signer = givenSigner({ signatureSnapshotObjectKey: null });
      (signer.account.user as Record<string, unknown>).signature = null;
      documentQueryBuilder.getOne.mockResolvedValue(
        givenDocument({ collaborators: [signer] }),
      );

      await expect(useCase.execute(DOCUMENT_ID)).rejects.toBeInstanceOf(
        IncompleteSimpleSignatureDataException,
      );
      expect(minioService.getFileInBytesFormat).not.toHaveBeenCalled();
      expect(sealApiService.sendSimpleSignatures).not.toHaveBeenCalled();
    });

    it('el archivo almacenado no es un PNG', async () => {
      documentQueryBuilder.getOne.mockResolvedValue(givenDocument());
      minioService.getFileInBytesFormat.mockResolvedValue(
        Buffer.from('%PDF-1.7 esto no es una imagen'),
      );

      await expect(useCase.execute(DOCUMENT_ID)).rejects.toBeInstanceOf(
        IncompleteSimpleSignatureDataException,
      );
      expect(sealApiService.sendSimpleSignatures).not.toHaveBeenCalled();
    });

    it('falta la información personal del firmante', async () => {
      const signer = givenSigner();
      (signer.account.user as Record<string, unknown>).personalInformation =
        null;
      (signer.account.user as Record<string, unknown>).nationalId = null;
      documentQueryBuilder.getOne.mockResolvedValue(
        givenDocument({ collaborators: [signer] }),
      );

      await expect(useCase.execute(DOCUMENT_ID)).rejects.toBeInstanceOf(
        IncompleteSimpleSignatureDataException,
      );
      expect(sealApiService.sendSimpleSignatures).not.toHaveBeenCalled();
    });

    it('el colaborador no tiene cuenta de plataforma vinculada', async () => {
      documentQueryBuilder.getOne.mockResolvedValue(
        givenDocument({ collaborators: [givenSigner({ account: null })] }),
      );

      await expect(useCase.execute(DOCUMENT_ID)).rejects.toBeInstanceOf(
        IncompleteSimpleSignatureDataException,
      );
      expect(sealApiService.sendSimpleSignatures).not.toHaveBeenCalled();
    });

    it('el mensaje señala el dato y el firmante, sin exponer datos personales', async () => {
      documentQueryBuilder.getOne.mockResolvedValue(givenDocument());
      verificationCodeQueryBuilder.getOne.mockResolvedValue(null);

      const error = await useCase.execute(DOCUMENT_ID).catch((e: Error) => e);
      const message = (error as Error).message;

      expect(message).toContain('código de verificación consumido');
      expect(message).toContain('collab-1');
      for (const dato of [
        'firmante@example.com',
        'RAMJ850101MDFXXX01',
        'Juana',
        'Ramírez',
        '123456',
      ]) {
        expect(message).not.toContain(dato);
      }
    });
  });
});
