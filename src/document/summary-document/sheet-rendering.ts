// El proyecto no tiene esModuleInterop habilitado (ver tsconfig.json) y pdfmake exporta la
// clase vía `module.exports = PdfPrinter` (CommonJS puro, sin __esModule) — `import ... from`
// se transpilaría a `.default`, que no existe, y rompe en runtime. `import = require` es la
// forma segura de consumir un `export =` bajo ese tsconfig.
import PdfPrinter = require('pdfmake');
import { TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces';
import * as path from 'path';

/**
 * Plomería compartida por las hojas de evidencia (firma simple y firma avanzada): fuentes,
 * render a Buffer y los helpers de formato del layout monoespaciado.
 *
 * Acá vive solo lo que NO distingue a una hoja de la otra. El contenido —textos legales, tablas,
 * qué campos se imprimen— es propio de cada servicio a propósito: la firma simple y la avanzada
 * se apoyan en artículos distintos del Código de Comercio y su evidencia va a seguir evolucionando
 * por separado, así que compartir el contenido obligaría a coordinar cambios que no tienen por qué
 * estar acoplados.
 *
 * Este archivo vive junto a `fonts/` porque `__dirname` es lo que resuelve la ruta de los .ttf
 * tanto en `src/` como en `dist/` (nest-cli.json los copia al build como asset).
 */

export const BRAND_COLOR = '#1a56db';

/** Ancho de los banners de guiones (`----Firmas----`) del layout de referencia. */
export const MONO_BANNER_WIDTH = 70;

/**
 * Roboto (proporcional, para el texto legal) viene de node_modules/pdfmake — npm no publica los
 * .ttf de sus ejemplos, así que se copian una sola vez a este módulo (ver fonts/Roboto/*.ttf) y
 * se registran en nest-cli.json como asset (*.ttf) para que el build los incluya en dist/.
 * Courier es una de las 14 fuentes estándar de PDF: PDFKit la resuelve por nombre sin necesitar
 * un archivo .ttf.
 */
export const SHEET_FONT_DESCRIPTORS: TFontDictionary = {
  Roboto: {
    normal: path.join(__dirname, 'fonts', 'Roboto', 'Roboto-Regular.ttf'),
    bold: path.join(__dirname, 'fonts', 'Roboto', 'Roboto-Medium.ttf'),
    italics: path.join(__dirname, 'fonts', 'Roboto', 'Roboto-Italic.ttf'),
    bolditalics: path.join(
      __dirname,
      'fonts',
      'Roboto',
      'Roboto-MediumItalic.ttf',
    ),
  },
  Courier: {
    normal: 'Courier',
    bold: 'Courier-Bold',
    italics: 'Courier-Oblique',
    bolditalics: 'Courier-BoldOblique',
  },
};

/** Ejecuta pdfmake y devuelve el PDF en memoria; no toca disco ni MinIO. */
export async function renderSheetPdf(
  docDefinition: TDocumentDefinitions,
): Promise<Buffer> {
  const printer = new PdfPrinter(SHEET_FONT_DESCRIPTORS);
  const pdfDoc = printer.createPdfKitDocument(docDefinition);

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}

/** "label" + espacios hasta `width` + "valor" — replica el layout de columna fija de la plantilla. Si el label ya excede `width`, se agrega un solo espacio en vez de truncar el valor. */
export function padLabel(label: string, value: string, width: number): string {
  const padding = ' '.repeat(Math.max(width - label.length, 1));
  return `${label}${padding}${value ?? ''}`;
}

/** `-------Firmas-------`: el título centrado entre guiones de la plantilla de referencia. */
export function dashBanner(label: string, width = MONO_BANNER_WIDTH): string {
  const dashes = Math.max(width - label.length, 0);
  const left = Math.floor(dashes / 2);
  const right = dashes - left;
  return `${'-'.repeat(left)}${label}${'-'.repeat(right)}`;
}

/** Fecha legible es-MX, o cadena vacía si el valor falta o no es una fecha válida. */
export function formatSheetDate(
  value: Date | string | null | undefined,
): string {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('es-MX', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}
