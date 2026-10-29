/**
 * Los 8 bytes con los que empieza todo archivo PNG (RFC 2083, §3.1). Los tres primeros dígitos
 * imprimibles deletrean "PNG"; el resto está pensado para detectar transferencias que hayan
 * corrompido el archivo.
 */
const PNG_MAGIC_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Comprueba el contenido del archivo, no lo que el cliente dice que es.
 *
 * El `mimetype` de un multipart lo escribe quien sube el archivo: es una etiqueta, no una
 * prueba. La firma de bytes sí está dentro del archivo, así que es lo que decide — y es barato,
 * porque son los primeros 8 bytes de un buffer que ya está en memoria.
 */
export function isPngBuffer(buffer: Buffer | undefined): boolean {
  if (!buffer || buffer.length < PNG_MAGIC_BYTES.length) {
    return false;
  }

  return buffer.subarray(0, PNG_MAGIC_BYTES.length).equals(PNG_MAGIC_BYTES);
}
