import type { Request } from 'express';
import type { StorageEngine } from 'multer';

import {
  VerificationFileAnalyzer,
  type VerificationFileAnalysis,
} from './verification-file-analyzer';

/** Lo que queda en `req.file` tras la subida: el análisis, nunca el contenido. */
export interface VerificationUploadedFile {
  fieldname: string;
  verification: VerificationFileAnalysis;
}

/**
 * Motor de almacenamiento de multer que NO almacena: pasa cada trozo del archivo por
 * `VerificationFileAnalyzer` y lo descarta. Así el SHA-256 se calcula en streaming —sin cargar el
 * archivo completo en memoria ni escribirlo a disco— y del archivo sólo sobrevive su análisis.
 *
 * Cuando el resultado ya está decidido (tipo no admitido, demasiado grande, contenido inválido)
 * se sigue drenando el stream sin procesarlo: multer necesita consumirlo para cerrar la petición, y
 * su `limits.fileSize` corta lo que exceda el tope general.
 *
 * @example
 * ```ts
 * FileInterceptor('file', { storage: new VerificationUploadStorage(), limits: { fileSize, files: 1 } })
 * ```
 */
export class VerificationUploadStorage implements StorageEngine {
  /**
   * @param _req - Petición (no se usa).
   * @param file - Archivo entrante, con su stream.
   * @param callback - Recibe el análisis, que multer mezcla en `req.file`.
   * @returns Nada.
   */
  _handleFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (
      error?: unknown,
      info?: Partial<Express.Multer.File> & {
        verification?: VerificationFileAnalysis;
      },
    ) => void,
  ): void {
    const analyzer = new VerificationFileAnalyzer({
      originalName: file.originalname,
      mimeType: file.mimetype,
    });
    let done = false;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      if (error) {
        callback(error);
        return;
      }
      callback(null, { verification: analyzer.finish() });
    };

    file.stream.on('data', (chunk: Buffer) => {
      if (!analyzer.settled) analyzer.write(chunk);
    });
    file.stream.on('end', () => finish());
    file.stream.on('error', (error) => finish(error));
  }

  /**
   * Nada que borrar: no se guardó nada.
   *
   * @param _req - Petición.
   * @param _file - Archivo.
   * @param callback - Se llama de inmediato.
   * @returns Nada.
   */
  _removeFile(
    _req: Request,
    _file: Express.Multer.File,
    callback: (error: Error | null) => void,
  ): void {
    callback(null);
  }
}
