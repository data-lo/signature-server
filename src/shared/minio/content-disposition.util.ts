/**
 * Nombre con el que el navegador guarda un documento descargado.
 *
 * Sin esto, el archivo aterriza con el nombre del objeto en MinIO —un UUID— porque es lo último
 * que trae la URL prefirmada. El nombre configurado del documento vive en `documents.file_name` y
 * es el que el usuario reconoce; el UUID no le dice nada y además le deja un identificador interno
 * nuestro en la carpeta de descargas.
 */

/** Nombre de reserva cuando el documento no trae uno utilizable. Legible y sin el ID adentro. */
const FALLBACK_BASE_NAME = 'documento';

const PDF_EXTENSION = '.pdf';

/**
 * Lo que no puede viajar en un nombre de archivo: separadores de ruta (un `../` haría que el
 * navegador lo guarde fuera de la carpeta de descargas), los caracteres que Windows prohíbe, las
 * comillas —que cerrarían el `filename="..."` de la cabecera antes de tiempo— y los de control,
 * que permitirían inyectar un salto de línea y con él una cabecera HTTP entera.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\/:*?"<>|]/g;

/** Marcas diacríticas sueltas que deja `normalize('NFD')` al descomponer una letra acentuada. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Todo lo que no sea ASCII imprimible: lo único que admite un `filename` sin codificar. */
const NON_ASCII = /[^\u0020-\u007e]/g;

/**
 * Deja el nombre en algo que se pueda escribir en disco, con su extensión `.pdf`.
 *
 * No se recorta a un largo máximo: los sistemas de archivos actuales admiten 255 bytes y el nombre
 * de un documento no se acerca; truncar a ciegas partiría por la mitad un nombre legítimo.
 */
export function sanitizeDownloadFileName(
  fileName: string | null | undefined,
): string {
  const cleaned = (fileName ?? '')
    .replace(UNSAFE_CHARACTERS, ' ')
    // Espacios repetidos, y espacios o puntos en los bordes: Windows rechaza un nombre que termina
    // en punto o espacio, y uno que empieza con punto queda oculto en sistemas Unix.
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');

  const base = cleaned || FALLBACK_BASE_NAME;

  return base.toLowerCase().endsWith(PDF_EXTENSION)
    ? base
    : `${base}${PDF_EXTENSION}`;
}

/**
 * Arma la cabecera `Content-Disposition` con la que MinIO responde la descarga.
 *
 * El nombre va DOS veces, como manda el RFC 6266: `filename` en ASCII para los clientes viejos y
 * `filename*` en UTF-8 para los actuales, que es el que gana cuando están los dos. Sin `filename*`,
 * un documento llamado "Contrato de prestación de servicios.pdf" llegaría con la acentuada rota, y
 * en español ese es el caso normal, no el raro.
 *
 * La versión ASCII no inventa un nombre distinto: descompone los acentos y conserva la letra base,
 * así que "prestación" cae en "prestacion" y sigue leyéndose igual.
 */
export function buildAttachmentDisposition(
  fileName: string | null | undefined,
): string {
  const safeName = sanitizeDownloadFileName(fileName);

  const asciiName =
    safeName
      .normalize('NFD')
      .replace(COMBINING_MARKS, '')
      .replace(NON_ASCII, '_') || `${FALLBACK_BASE_NAME}${PDF_EXTENSION}`;

  return (
    `attachment; filename="${asciiName}"; ` +
    `filename*=UTF-8''${encodeURIComponent(safeName)}`
  );
}
