import { ConfigService } from '@nestjs/config';
import { DiditMediaDownloaderService } from './didit-media-downloader.service';
import { IdentityDocumentImagesProcessingException } from '../exceptions/identity-verification.exceptions';

/** Token de la URL prefirmada: ningún mensaje de error puede contenerlo. */
const URL_SECRET = 'X-Amz-Signature=secreto-de-la-url';
const IMAGE_URL = `https://media.didit.me/ine/front.jpg?${URL_SECRET}`;

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('contenido-de-la-ine'),
]);

/**
 * Construye el servicio con la configuración indicada.
 *
 * @param config - Variables de entorno simuladas.
 * @returns El servicio listo para usar.
 *
 * @example
 * const downloader = buildDownloader({ DIDIT_MEDIA_MAX_BYTES: '10' });
 */
function buildDownloader(config: Record<string, string> = {}) {
  return new DiditMediaDownloaderService({
    get: (key: string) => config[key],
  } as unknown as ConfigService);
}

/**
 * Respuesta HTTP simulada del proveedor.
 *
 * @param body - Cuerpo de la respuesta.
 * @param init - Status y cabeceras.
 * @returns Una `Response` real de la API de fetch de Node.
 *
 * @example
 * imageResponse(JPEG, { headers: { 'content-type': 'image/jpeg' } });
 */
function imageResponse(
  body: Buffer,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(new Uint8Array(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'image/jpeg' },
  });
}

describe('DiditMediaDownloaderService', () => {
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(imageResponse(JPEG));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  /**
   * Captura el error de una descarga que debe fallar.
   *
   * @param downloader - Servicio a probar.
   * @param url - URL a descargar.
   * @returns La excepción lanzada.
   *
   * @example
   * const error = await failure(buildDownloader(), 'https://evil.com/x.jpg');
   */
  async function failure(
    downloader: DiditMediaDownloaderService,
    url = IMAGE_URL,
  ): Promise<IdentityDocumentImagesProcessingException> {
    const error = await downloader.download(url, 'frontal').catch((e) => e);
    expect(error).toBeInstanceOf(IdentityDocumentImagesProcessingException);
    expect((error as Error).message).not.toContain(URL_SECRET);
    expect((error as Error).message).not.toContain('media.didit.me');
    return error;
  }

  describe('descarga válida', () => {
    it('devuelve el contenido, su tipo y la extensión con la que se guarda', async () => {
      const image = await buildDownloader().download(IMAGE_URL, 'frontal');

      expect(image.content.equals(JPEG)).toBe(true);
      expect(image.contentType).toBe('image/jpeg');
      expect(image.extension).toBe('jpg');
    });

    it('no sigue redirecciones: llevarían a un host que no se validó', async () => {
      await buildDownloader().download(IMAGE_URL, 'frontal');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ redirect: 'error' }),
      );
    });

    it('acepta la variante image/jpg del tipo declarado', async () => {
      fetchMock.mockResolvedValue(
        imageResponse(JPEG, { headers: { 'content-type': 'image/jpg' } }),
      );

      await expect(
        buildDownloader().download(IMAGE_URL, 'frontal'),
      ).resolves.toMatchObject({ contentType: 'image/jpeg' });
    });

    it('permite HTTP contra localhost si está en la lista (doble e2e de Didit)', async () => {
      const downloader = buildDownloader({
        DIDIT_MEDIA_ALLOWED_HOSTS: 'localhost',
      });

      await expect(
        downloader.download(
          'http://localhost:3010/media/ine-front.jpg',
          'frontal',
        ),
      ).resolves.toMatchObject({ contentType: 'image/jpeg' });
    });
  });

  describe('host y protocolo', () => {
    it.each([
      ['un host ajeno', 'https://evil.com/ine.jpg'],
      [
        'un dominio que sólo termina parecido',
        'https://didit.me.evil.com/ine.jpg',
      ],
      ['HTTP plano fuera de localhost', 'http://media.didit.me/ine.jpg'],
      ['credenciales en la URL', 'https://user:pass@media.didit.me/ine.jpg'],
      ['una URL inválida', 'no-es-una-url'],
    ])('rechaza %s sin descargar nada', async (_caso, url) => {
      await failure(buildDownloader(), url);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('no permite localhost si no está en la lista', async () => {
      await failure(buildDownloader(), 'http://localhost:3010/media/ine.jpg');
    });
  });

  describe('respuesta del proveedor', () => {
    it('rechaza una respuesta que no es 2xx', async () => {
      fetchMock.mockResolvedValue(imageResponse(JPEG, { status: 403 }));

      const error = await failure(buildDownloader());
      expect(error.message).toContain('HTTP 403');
    });

    it('rechaza un tipo de contenido que no es imagen', async () => {
      fetchMock.mockResolvedValue(
        imageResponse(JPEG, { headers: { 'content-type': 'text/html' } }),
      );

      await failure(buildDownloader());
    });

    it('rechaza una imagen cuyo tamaño declarado excede el máximo', async () => {
      fetchMock.mockResolvedValue(
        imageResponse(JPEG, {
          headers: { 'content-type': 'image/jpeg', 'content-length': '999999' },
        }),
      );

      await failure(buildDownloader({ DIDIT_MEDIA_MAX_BYTES: '100' }));
    });

    it('corta la lectura si el cuerpo excede el máximo aunque no lo declare', async () => {
      await failure(buildDownloader({ DIDIT_MEDIA_MAX_BYTES: '5' }));
    });

    it('rechaza bytes que no corresponden al tipo declarado', async () => {
      fetchMock.mockResolvedValue(
        imageResponse(JPEG, { headers: { 'content-type': 'image/png' } }),
      );

      await failure(buildDownloader());
    });

    it('rechaza una imagen vacía', async () => {
      fetchMock.mockResolvedValue(imageResponse(Buffer.alloc(0)));

      await failure(buildDownloader());
    });

    it('traduce un fallo de red sin exponer la URL', async () => {
      fetchMock.mockRejectedValue(
        new TypeError(`fetch failed for ${IMAGE_URL}`),
      );

      const error = await failure(buildDownloader());
      expect(error.message).toContain('no se pudo descargar');
    });
  });
});
