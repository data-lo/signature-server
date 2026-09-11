import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  detectImageContentType,
  type SupportedImageContentType,
} from 'src/shared/utils/image-content-type.util';
import { IdentityDocumentImagesProcessingException } from '../exceptions/identity-verification.exceptions';

/**
 * Hosts desde los que se aceptan las imágenes cuando `DIDIT_MEDIA_ALLOWED_HOSTS` no está definido.
 * Cuenta el host exacto o cualquier subdominio: Didit sirve sus archivos desde su dominio o desde
 * almacenamiento de AWS con URLs prefirmadas.
 */
export const DEFAULT_DIDIT_MEDIA_ALLOWED_HOSTS = ['didit.me', 'amazonaws.com'];

/** Tamaño máximo por imagen cuando `DIDIT_MEDIA_MAX_BYTES` no está definido: 10 MB. */
export const DEFAULT_DIDIT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Tiempo máximo para descargar una imagen: una URL prefirmada colgada no debe retener el webhook. */
const DIDIT_MEDIA_TIMEOUT_MS = 15_000;

/**
 * Hosts de desarrollo a los que se permite HTTP plano, SIEMPRE que además estén en la lista de hosts
 * permitidos (la suite e2e sirve las imágenes desde un doble local de Didit).
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** Tipos que se aceptan en la cabecera `Content-Type`, con el tipo canónico al que equivalen. */
const ALLOWED_DECLARED_TYPES: Record<string, SupportedImageContentType> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

const EXTENSION_BY_CONTENT_TYPE: Record<SupportedImageContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Cara de la INE, sólo para los mensajes de error. */
export type IdentityImageSide = 'frontal' | 'trasera';

/** Imagen descargada y validada. Quien la recibe debe borrar `content` en cuanto no lo necesite. */
export interface DownloadedIdentityImage {
  content: Buffer;
  contentType: SupportedImageContentType;
  extension: string;
}

/**
 * Descarga desde Didit una imagen de la INE verificada y comprueba que sea una imagen confiable.
 *
 * Es un adaptador HTTP, como `DiditApiService`: su única razón de cambio es el proveedor. Valida,
 * en este orden, antes de devolver un solo byte:
 *
 * 1. Que la URL sea HTTPS (HTTP sólo contra `localhost`) y no traiga credenciales.
 * 2. Que el host esté permitido (`DIDIT_MEDIA_ALLOWED_HOSTS`): la URL llega en un payload firmado,
 *    pero sin esta lista cualquier contenido de ese payload decidiría a qué servidor le pega el
 *    backend.
 * 3. Que la respuesta sea 2xx, sin seguir redirecciones (llevarían a un host no validado).
 * 4. Que el `Content-Type` declarado sea JPEG, PNG o WebP.
 * 5. Que no exceda `DIDIT_MEDIA_MAX_BYTES`, ni por la cabecera ni por lo que realmente llega.
 * 6. Que los bytes mágicos correspondan al tipo declarado: no se guarda como INE algo que no lo es.
 *
 * **Ningún mensaje de error incluye la URL**, que es una credencial temporal sobre un documento de
 * identidad: sólo la cara (frontal/trasera) y el motivo.
 */
@Injectable()
export class DiditMediaDownloaderService {
  private readonly allowedHosts: string[];
  private readonly maxBytes: number;

  constructor(configService: ConfigService) {
    this.allowedHosts = parseHosts(
      configService.get<string>('DIDIT_MEDIA_ALLOWED_HOSTS'),
    );
    const configuredMaxBytes = Number(
      configService.get<string>('DIDIT_MEDIA_MAX_BYTES'),
    );
    this.maxBytes =
      configuredMaxBytes > 0
        ? configuredMaxBytes
        : DEFAULT_DIDIT_MEDIA_MAX_BYTES;
  }

  /**
   * Descarga y valida una imagen de la INE.
   *
   * @param url - URL de la imagen tal como la entregó Didit en el veredicto.
   * @param side - Cara de la INE, para el mensaje de error.
   * @returns La imagen, con su tipo detectado y la extensión con la que se guarda.
   *
   * @throws {IdentityDocumentImagesProcessingException} Si la URL no es válida, el host o el protocolo
   *   no están permitidos, la descarga falla o no responde 2xx, el tipo no es de imagen permitido,
   *   excede el tamaño máximo, llega vacía o sus bytes no corresponden al tipo declarado.
   *
   * @example
   * ```ts
   * const front = await downloader.download(urls.front, 'frontal');
   * ```
   */
  async download(
    url: string,
    side: IdentityImageSide,
  ): Promise<DownloadedIdentityImage> {
    const target = this.parseAllowedUrl(url, side);

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(target, {
        redirect: 'error',
        signal: AbortSignal.timeout(DIDIT_MEDIA_TIMEOUT_MS),
      });
    } catch (error) {
      throw new IdentityDocumentImagesProcessingException(
        `la imagen ${side} no se pudo descargar (${describeFetchError(error)})`,
      );
    }

    if (!response.ok) {
      throw new IdentityDocumentImagesProcessingException(
        `la imagen ${side} respondió HTTP ${response.status}`,
      );
    }

    const declaredType =
      ALLOWED_DECLARED_TYPES[
        (response.headers.get('content-type') ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase()
      ];

    if (!declaredType) {
      throw new IdentityDocumentImagesProcessingException(
        `la imagen ${side} no es de un tipo permitido (JPEG, PNG o WebP)`,
      );
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > this.maxBytes) {
      throw new IdentityDocumentImagesProcessingException(
        `la imagen ${side} excede el tamaño máximo permitido`,
      );
    }

    const content = await this.readWithLimit(response, side);

    if (content.length === 0) {
      throw new IdentityDocumentImagesProcessingException(
        `la imagen ${side} llegó vacía`,
      );
    }

    if (detectImageContentType(content) !== declaredType) {
      content.fill(0);
      throw new IdentityDocumentImagesProcessingException(
        `el contenido de la imagen ${side} no corresponde a una imagen ${declaredType}`,
      );
    }

    return {
      content,
      contentType: declaredType,
      extension: EXTENSION_BY_CONTENT_TYPE[declaredType],
    };
  }

  /**
   * Convierte la URL del veredicto en una URL permitida, o rechaza.
   *
   * @param raw - URL tal como llegó.
   * @param side - Cara de la INE, para el mensaje.
   * @returns La URL ya parseada.
   *
   * @throws {IdentityDocumentImagesProcessingException} Si no es una URL, no es HTTPS (salvo
   *   `localhost`), trae credenciales o su host no está permitido.
   *
   * @example
   * ```ts
   * this.parseAllowedUrl('https://cdn.didit.me/front.jpg', 'frontal');
   * ```
   */
  private parseAllowedUrl(raw: string, side: IdentityImageSide): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new IdentityDocumentImagesProcessingException(
        `la URL de la imagen ${side} no es válida`,
      );
    }

    const host = url.hostname.toLowerCase();
    const isLocalHttp = url.protocol === 'http:' && LOCAL_HOSTS.includes(host);

    if (url.protocol !== 'https:' && !isLocalHttp) {
      throw new IdentityDocumentImagesProcessingException(
        `la imagen ${side} no se sirve por HTTPS`,
      );
    }

    if (url.username || url.password) {
      throw new IdentityDocumentImagesProcessingException(
        `la URL de la imagen ${side} no puede traer credenciales`,
      );
    }

    const allowed = this.allowedHosts.some(
      (allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`),
    );

    if (!allowed) {
      throw new IdentityDocumentImagesProcessingException(
        `la imagen ${side} no proviene de un host permitido del proveedor`,
      );
    }

    return url;
  }

  /**
   * Lee el cuerpo sin pasar del tamaño máximo, aunque la cabecera no lo declare o mienta.
   *
   * @param response - Respuesta de la descarga.
   * @param side - Cara de la INE, para el mensaje.
   * @returns Los bytes leídos.
   *
   * @throws {IdentityDocumentImagesProcessingException} Si excede el máximo o la lectura se corta.
   *
   * @example
   * ```ts
   * const content = await this.readWithLimit(response, 'trasera');
   * ```
   */
  private async readWithLimit(
    response: Awaited<ReturnType<typeof fetch>>,
    side: IdentityImageSide,
  ): Promise<Buffer> {
    if (!response.body) {
      return Buffer.alloc(0);
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        total += value.byteLength;
        chunks.push(Buffer.from(value));

        if (total > this.maxBytes) {
          await reader.cancel();
          chunks.forEach((chunk) => chunk.fill(0));
          throw new IdentityDocumentImagesProcessingException(
            `la imagen ${side} excede el tamaño máximo permitido`,
          );
        }
      }
    } catch (error) {
      if (error instanceof IdentityDocumentImagesProcessingException) {
        throw error;
      }
      chunks.forEach((chunk) => chunk.fill(0));
      throw new IdentityDocumentImagesProcessingException(
        `la descarga de la imagen ${side} se interrumpió`,
      );
    }

    const content = Buffer.concat(chunks, total);
    chunks.forEach((chunk) => chunk.fill(0));
    return content;
  }
}

/**
 * Lee la lista de hosts permitidos de la configuración.
 *
 * @param raw - Valor de `DIDIT_MEDIA_ALLOWED_HOSTS`, separado por comas.
 * @returns Los hosts en minúsculas y sin punto inicial; los de por defecto si no hay ninguno.
 *
 * @example
 * ```ts
 * parseHosts('didit.me, .amazonaws.com'); // ['didit.me', 'amazonaws.com']
 * ```
 */
function parseHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);

  return hosts.length > 0 ? hosts : DEFAULT_DIDIT_MEDIA_ALLOWED_HOSTS;
}

/**
 * Describe un fallo de `fetch` sin su mensaje, que puede incluir la URL.
 *
 * @param error - Lo que lanzó `fetch`.
 * @returns El nombre del error (`TimeoutError`, `TypeError`...).
 *
 * @example
 * ```ts
 * describeFetchError(new DOMException('x', 'TimeoutError')); // 'TimeoutError'
 * ```
 */
function describeFetchError(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'error de red';
}
