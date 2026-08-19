import { Test, TestingModule } from '@nestjs/testing';
import * as Minio from 'minio';
import { MinioService, toHeaderSafeValue } from './minio.service';
import { BUCKET_TYPES_ENUM } from './enums/bucket-types.enum';

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(() => ({
    bucketExists: jest.fn().mockResolvedValue(true),
    makeBucket: jest.fn().mockResolvedValue(undefined),
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
    process.env.MINIO_FINALIZED_DOCUMENTS_BUCKET = 'finalized-documents';
    process.env.MINIO_PARTIALLY_SIGNED_DOCUMENTS_BUCKET =
      'partially-signed-documents';
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

  /**
   * `setMinioClient` construye primero el privado y después el público, así que el orden de
   * instanciación es lo que distingue a uno de otro dentro del mock.
   */
  function privateClient() {
    return (Minio.Client as unknown as jest.Mock).mock.results[0].value;
  }

  function publicClient() {
    return (Minio.Client as unknown as jest.Mock).mock.results[1].value;
  }

  function clientOptions(index: number) {
    return (Minio.Client as unknown as jest.Mock).mock.calls[index][0];
  }

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  /**
   * Bug corregido: la verificación previa era `bucketExists(bucket, callback)`, pero minio-js
   * devuelve una promesa y nunca invoca ese callback — un bucket inexistente no se detectaba y el
   * flujo reventaba más adelante en `putObject` con un `NoSuchBucket` crudo. Se notó al agregar
   * `finalized_documents`, que ningún entorno tenía creado.
   */
  describe('creación del bucket cuando no existe', () => {
    const pdf = {
      file: Buffer.from('%PDF-1.7'),
      name: 'contrato.pdf',
      mimetype: 'application/pdf',
    };

    it('crea el bucket antes de subir cuando no existe, en vez de fallar en putObject', async () => {
      privateClient().bucketExists.mockResolvedValue(false);

      await service.uploadPdfAObject(
        pdf,
        BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        'Ana Lopez',
        'object-key-1',
      );

      expect(privateClient().makeBucket).toHaveBeenCalledWith(
        'finalized-documents',
        undefined,
      );
      expect(privateClient().putObject).toHaveBeenCalled();
    });

    it('si el bucket ya existe no intenta crearlo', async () => {
      await service.uploadPdfAObject(
        pdf,
        BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
        'Ana Lopez',
      );

      expect(privateClient().makeBucket).not.toHaveBeenCalled();
    });

    it('una carrera entre dos finalizaciones no rompe: BucketAlreadyOwnedByYou se trata como éxito', async () => {
      privateClient().bucketExists.mockResolvedValue(false);
      privateClient().makeBucket.mockRejectedValue(
        Object.assign(new Error('ya existe'), {
          code: 'BucketAlreadyOwnedByYou',
        }),
      );

      await expect(
        service.uploadPdfAObject(
          pdf,
          BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
          'Ana Lopez',
        ),
      ).resolves.toEqual(
        expect.objectContaining({ bucket: 'finalized-documents' }),
      );
    });

    it('sin permiso para crearlo, el error dice qué hacer en vez de dejar un NoSuchBucket suelto', async () => {
      privateClient().bucketExists.mockResolvedValue(false);
      privateClient().makeBucket.mockRejectedValue(
        Object.assign(new Error('denegado'), { code: 'AccessDenied' }),
      );

      await expect(
        service.uploadPdfAObject(
          pdf,
          BUCKET_TYPES_ENUM.FINALIZED_DOCUMENTS,
          'Ana Lopez',
        ),
      ).rejects.toThrow(/no existe y no se pudo crear/i);
    });
  });

  /**
   * Sin `region` explícita el SDK la resuelve con una llamada de red en la primera operación que
   * la necesite, sobre el protocolo del cliente que la dispara — con useSSL=true contra un MinIO
   * en HTTP plano eso termina en EPROTO. Aplica a los DOS clientes, y más al público desde que la
   * subida del PDF firmado pasa por él.
   */
  it('ambos clientes se construyen con una región explícita, para no resolverla por red', () => {
    expect(clientOptions(0)).toEqual(
      expect.objectContaining({ region: 'us-east-1' }),
    );
    expect(clientOptions(1)).toEqual(
      expect.objectContaining({ region: 'us-east-1' }),
    );
  });

  it('respeta MINIO_REGION cuando está configurada', async () => {
    process.env.MINIO_REGION = 'mx-central-1';
    (Minio.Client as unknown as jest.Mock).mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [MinioService],
    }).compile();
    module.get<MinioService>(MinioService);

    expect(clientOptions(1)).toEqual(
      expect.objectContaining({ region: 'mx-central-1' }),
    );
    delete process.env.MINIO_REGION;
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
      return privateClient().putObject.mock.calls[0];
    }

    /**
     * La subida es servidor→MinIO y va por la red interna. El cliente público existe solo para
     * FIRMAR la URL que el navegador pide directamente (`getFile`), porque SigV4 firma incluyendo
     * el host y hay que usar el que el navegador puede resolver. Mandar la subida por ahí la
     * haría salir por el proxy que termina TLS —con su límite de tamaño de cuerpo— en el último
     * paso del flujo de firma.
     */
    it('sube por el cliente privado: la subida no sale a la red pública', async () => {
      await service.uploadPdfAObject(
        pdf,
        BUCKET_TYPES_ENUM.SIGNED_DOCUMENTS,
        'Ana Lopez',
        'object-key-1',
      );

      expect(privateClient().putObject).toHaveBeenCalledTimes(1);
      expect(privateClient().bucketExists).toHaveBeenCalledWith(
        'signed-documents',
      );
      expect(publicClient().putObject).not.toHaveBeenCalled();
    });

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
