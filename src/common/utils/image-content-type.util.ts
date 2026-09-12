/** Tipos de imagen que se aceptan para la INE verificada. */
export type SupportedImageContentType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

/** Firma de archivo PNG (89 50 4E 47 0D 0A 1A 0A). */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Detecta el tipo de una imagen por sus primeros bytes ("bytes mágicos").
 *
 * Se mira el contenido y no la extensión ni la cabecera `Content-Type`: esas las declara quien
 * sirve o sube el archivo, los bytes no. Reconoce JPEG (`FF D8 FF`), PNG y WebP (`RIFF....WEBP`).
 *
 * @param content - Bytes del archivo.
 * @returns El tipo MIME detectado, o `null` si no es ninguno de los soportados.
 *
 * @example
 * ```ts
 * detectImageContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // 'image/jpeg'
 * detectImageContentType(Buffer.from('hola')); // null
 * ```
 */
export function detectImageContentType(
  content: Buffer,
): SupportedImageContentType | null {
  if (
    content.length >= 3 &&
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    content.length >= PNG_SIGNATURE.length &&
    content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return 'image/png';
  }

  if (
    content.length >= 12 &&
    content.toString('ascii', 0, 4) === 'RIFF' &&
    content.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}
