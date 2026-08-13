import { Test, TestingModule } from '@nestjs/testing';
import * as Minio from 'minio';
import { MinioService, toHeaderSafeValue } from './minio.service';
import { BUCKET_TYPES_ENUM } from './enums/bucket-types.enum';

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(() => ({
    bucketExists: jest.fn().mockResolvedValue(true),
    putObject: jest.fn().mockResolvedValue({ etag: 'etag-1' }),
    statObject: jest.fn().mockResolvedValue({ size: 1 }),
    presignedGetObject: jest.fn().mockResolvedValue('https://minio/file'),
  })),
}));

describe('MinioService', () => {
  let service: MinioService;

  beforeEach(async () => {
    process.env.MINIO_HOST = 'localhost';
    process.env.MINIO_PORT = '9010';
    process.env.MINIO_PUBLIC_HOST = 'localhost';
    process.env.MINIO_PUBLIC_PORT = '9010';
    process.env.MINIO_ACCESS_KEY = 'test-access-key';
    process.env.MINIO_SECRET_KEY = 'test-secret-key';
    process.env.MINIO_CREATED_DOCUMENTS_BUCKET = 'created-documents';
    process.env.MINIO_SIGNED_DOCUMENTS_BUCKET = 'signed-documents';
    process.env.MINIO_CANCELLED_DOCUMENTS_BUCKET = 'cancelled-documents';
    process.env.MINIO_REJECTED_DOCUMENTS_BUCKET = 'rejected-documents';
    process.env.MINIO_OFICIAL_CARDS_BUCKET = 'oficial-id-cards';
    process.env.MINIO_SIGNATURE_IMAGES_BUCKET = 'signature-images';

    (Minio.Client as unknown as jest.Mock).mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [MinioService],
    }).compile();

    service = module.get<MinioService>(MinioService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  /**
   * `uploadPdfAObject` es la subida de todo PDF ya procesado (firmado, rechazado o cancelado).
   * Los metadatos se pasaban en un 6º argumento que minio-js no recibe —su firma es
   * `putObject(bucket, objeto, stream, size?, metaData?)`— así que se perdían y el objeto
   * terminaba almacenado como `binary/octet-stream` con el mimetype deletreado carácter por
   * carácter. Estas pruebas fijan la forma de la llamada, que es donde estaba el error.
   */
  describe('uploadPdfAObject', () => {
    const pdf = {
      file: Buffer.from('%PDF-1.7 contenido'),
      name: 'contrato.pdf',
      mimetype: 'application/pdf',
    };

    function putObjectCall() {
      const client = (Minio.Client as unknown as jest.Mock).mock.results[0]
        .value;
      return client.putObject.mock.calls[0];
    }

    it('manda los metadatos como 5º argumento, junto al tamaño, y no un 6º que se descartaría', async () => {
      await service.uploadPdfAObject(
        pdf,
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        'Ana Lopez',
        'object-key-1',
      );

      const call = putObjectCall();
      expect(call).toHaveLength(5);
      expect(call[0]).toBe('signed-documents');
      expect(call[1]).toBe('object-key-1');
      expect(call[3]).toBe(pdf.file.length);
      expect(call[4]).toEqual({
        'Content-Type': 'application/pdf',
        'x-amz-meta-pdfa-conformance': 'PDF/A-2B',
        'x-amz-meta-signed-at': expect.any(String),
        'x-amz-meta-signer': 'Ana Lopez',
      });
    });

    it('registra la fecha de firma en formato ISO 8601', async () => {
      await service.uploadPdfAObject(
        pdf,
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        'Ana Lopez',
      );

      const signedAt = putObjectCall()[4]['x-amz-meta-signed-at'];
      expect(signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(new Date(signedAt).getTime()).not.toBeNaN();
    });

    it('codifica el nombre del firmante si trae caracteres que no caben en una cabecera HTTP', async () => {
      await service.uploadPdfAObject(
        pdf,
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        'José Pérez “el firmante”',
      );

      const signer = putObjectCall()[4]['x-amz-meta-signer'];
      expect(signer).toBe('Jos%C3%A9 P%C3%A9rez %E2%80%9Cel firmante%E2%80%9D');
      // Cualquier byte fuera del ASCII imprimible reventaría la petición en Node.
      expect(signer).toMatch(/^[\x20-\x7e]*$/);
      expect(decodeURIComponent(signer)).toBe('José Pérez “el firmante”');
    });
  });

  describe('toHeaderSafeValue', () => {
    it('deja intacto lo que ya es ASCII imprimible', () => {
      expect(toHeaderSafeValue('Ana Lopez (RFC: XAXX010101000)')).toBe(
        'Ana Lopez (RFC: XAXX010101000)',
      );
    });
  });
});
