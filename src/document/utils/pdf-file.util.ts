import { BadRequestException } from '@nestjs/common';

/** Tipo MIME que se acepta para el documento a firmar. */
export const PDF_MIME_TYPE = 'application/pdf';

/** Cabecera con la que empieza todo PDF (ISO 32000: `%PDF-<versión>`). */
const PDF_SIGNATURE = Buffer.from('%PDF-');

/**
 * Cuántos bytes iniciales se revisan buscando la cabecera. La especificación la pone al principio,
 * y los lectores toleran basura delante hasta 1024 bytes; más allá no es un PDF que se deba firmar.
 */
const PDF_SIGNATURE_WINDOW = 1024;

/**
 * Exige que el archivo recibido sea un PDF por su tipo declarado Y por sus bytes reales.
 *
 * El tipo MIME lo pone el cliente y no prueba nada por sí solo; la cabecera `%PDF-` sí está en el
 * contenido. Se comprueban los dos antes de leer páginas, calcular el hash o subir nada a MinIO,
 * para que un archivo cualquiera renombrado a `.pdf` no llegue a ningún almacenamiento.
 *
 * @param file - Archivo recibido por multer (en memoria).
 * @returns Nada.
 *
 * @throws {BadRequestException} (400) Si el tipo no es `application/pdf` o los bytes no empiezan
 *   como un PDF.
 *
 * @example
 * ```ts
 * assertPdfFile({ mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.7 …') } as Express.Multer.File);
 * ```
 */
export function assertPdfFile(
  file: Pick<Express.Multer.File, 'mimetype' | 'buffer'>,
): void {
  if (file.mimetype !== PDF_MIME_TYPE) {
    throw new BadRequestException('El documento debe ser un archivo PDF');
  }

  const head = file.buffer?.subarray(0, PDF_SIGNATURE_WINDOW);
  if (!head || head.indexOf(PDF_SIGNATURE) === -1) {
    throw new BadRequestException(
      'El archivo no es un PDF válido: su contenido no corresponde al tipo declarado',
    );
  }
}
