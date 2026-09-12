import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Readable } from 'node:stream';
import * as Minio from 'minio';
import {
  DEFAULT_IDENTITY_DOCUMENTS_BUCKET,
  MinioService,
} from './minio.service';
import { BUCKET_TYPES_ENUM } from './enums/bucket-types.enum';

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(() => ({
    bucketExists: jest.fn().mockResolvedValue(true),
    makeBucket: jest.fn().mockResolvedValue(undefined),
    putObject: jest.fn().mockResolvedValue({ etag: 'etag-1' }),
    getObject: jest.fn(),
  })),
}));

/** Llave de un objeto de la INE: nunca puede aparecer en un log ni en un error. */
const OBJECT_KEY = 'pi-1/verif-1/front.jpg';

/**
 * Objetos con datos personales sensibles (la INE verificada): se guardan y se leen del bucket
 * privado sin dejar su llave ni su contenido en los logs ni en los mensajes de error.
 */
describe('MinioService — objetos sensibles', () => {
  let service: MinioService;

  /**
   * El cliente privado es la primera instancia que crea `setMinioClient`.
   *
   * @returns El cliente simulado de MinIO.
   *
   * @example
   * privateClient().putObject;
   */
  function privateClient() {
    return (Minio.Client as unknown as jest.Mock).mock.results[0].value;
  }

  async function buildService(): Promise<MinioService> {
    (Minio.Client as unknown as jest.Mock).mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [MinioService],
    }).compile();
    return moduleRef.get(MinioService);
  }

  beforeEach(async () => {
    process.env.MINIO_HOST = 'localhost';
    process.env.MINIO_PORT = '9010';
    process.env.MINIO_PUBLIC_HOST = 'localhost';
    process.env.MINIO_PUBLIC_PORT = '9010';
    process.env.MINIO_ACCESS_KEY = 'test-access-key';
    process.env.MINIO_SECRET_KEY = 'test-secret-key';
    process.env.MINIO_CREATED_DOCUMENTS_BUCKET = 'created-documents';
    process.env.MINIO_SIGNED_DOCUMENTS_BUCKET = 'signed-documents';
    process.env.MINIO_FINALIZED_DOCUMENTS_BUCKET = 'finalized-documents';
    process.env.MINIO_PARTIALLY_SIGNED_DOCUMENTS_BUCKET =
      'partially-signed-documents';
    process.env.MINIO_CANCELLED_DOCUMENTS_BUCKET = 'cancelled-documents';
    process.env.MINIO_REJECTED_DOCUMENTS_BUCKET = 'rejected-documents';
    process.env.MINIO_OFICIAL_CARDS_BUCKET = 'oficial-id-cards';
    process.env.MINIO_SIGNATURE_IMAGES_BUCKET = 'signature-images';
    delete process.env.MINIO_IDENTITY_DOCUMENTS_BUCKET;

    service = await buildService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('putSensitiveObject', () => {
    it('guarda en el bucket privado identity-documents por defecto', async () => {
      const content = Buffer.from([0xff, 0xd8, 0xff]);

      await service.putSensitiveObject(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        OBJECT_KEY,
        content,
        'image/jpeg',
      );

      expect(DEFAULT_IDENTITY_DOCUMENTS_BUCKET).toBe('identity-documents');
      expect(privateClient().putObject).toHaveBeenCalledWith(
        'identity-documents',
        OBJECT_KEY,
        content,
        content.length,
        { 'Content-Type': 'image/jpeg' },
      );
    });

    it('respeta MINIO_IDENTITY_DOCUMENTS_BUCKET cuando está definido', async () => {
      process.env.MINIO_IDENTITY_DOCUMENTS_BUCKET = 'ine-privada';
      service = await buildService();

      await service.putSensitiveObject(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        OBJECT_KEY,
        Buffer.from([1]),
        'image/jpeg',
      );

      expect(privateClient().putObject.mock.calls[0][0]).toBe('ine-privada');
    });

    it('crea el bucket si no existe', async () => {
      privateClient().bucketExists.mockResolvedValue(false);

      await service.putSensitiveObject(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        OBJECT_KEY,
        Buffer.from([1]),
        'image/jpeg',
      );

      expect(privateClient().makeBucket).toHaveBeenCalledWith(
        'identity-documents',
        undefined,
      );
    });

    it('no registra la llave del objeto en los logs', async () => {
      const logs = [
        jest.spyOn(Logger.prototype, 'log').mockImplementation(),
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(),
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
      ];

      await service.putSensitiveObject(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        OBJECT_KEY,
        Buffer.from([1]),
        'image/jpeg',
      );

      for (const spy of logs) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(OBJECT_KEY);
      }
    });

    it('falla con el código de MinIO y sin la llave', async () => {
      privateClient().putObject.mockRejectedValue(
        Object.assign(new Error(`Access Denied for ${OBJECT_KEY}`), {
          code: 'AccessDenied',
        }),
      );

      const error = await service
        .putSensitiveObject(
          BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
          OBJECT_KEY,
          Buffer.from([1]),
          'image/jpeg',
        )
        .catch((e: Error) => e);

      expect((error as Error).message).toContain('AccessDenied');
      expect((error as Error).message).not.toContain(OBJECT_KEY);
    });
  });

  describe('getSensitiveObject', () => {
    it('devuelve el contenido completo del objeto', async () => {
      privateClient().getObject.mockResolvedValue(
        Readable.from([Buffer.from('ane'), Buffer.from('rso')]),
      );

      const content = await service.getSensitiveObject(
        BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS,
        OBJECT_KEY,
      );

      expect(content.toString()).toBe('anerso');
      expect(privateClient().getObject).toHaveBeenCalledWith(
        'identity-documents',
        OBJECT_KEY,
      );
    });

    it('falla con el código de MinIO y sin la llave', async () => {
      privateClient().getObject.mockRejectedValue(
        Object.assign(
          new Error(`The specified key ${OBJECT_KEY} does not exist`),
          {
            code: 'NoSuchKey',
          },
        ),
      );

      const error = await service
        .getSensitiveObject(BUCKET_TYPES_ENUM.IDENTITY_DOCUMENTS, OBJECT_KEY)
        .catch((e: Error) => e);

      expect((error as Error).message).toContain('NoSuchKey');
      expect((error as Error).message).not.toContain(OBJECT_KEY);
    });
  });
});
