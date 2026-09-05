// El proyecto no tiene esModuleInterop habilitado (ver tsconfig.json) y pdfmake exporta la
// clase vía `module.exports = PdfPrinter` (CommonJS puro, sin __esModule) — `import ... from`
// se transpilaría a `.default`, que no existe, y rompe en runtime. `import = require` es la
// forma segura de consumir un `export =` bajo ese tsconfig.
import PdfPrinter = require('pdfmake');
import {
  Column,
  Content,
  ContentColumns,
  ContentTable,
  StyleDictionary,
  TDocumentDefinitions,
  TFontDictionary,
} from 'pdfmake/interfaces';
import * as path from 'path';

/**
 * Plomería compartida por las dos hojas de evidencia: tipografías, logo, render a Buffer y las
 * piezas de layout que ambas plantillas tienen idénticas —encabezado, pie de página y tablas
 * informativas.
 *
 * Acá vive lo que NO distingue a una hoja de la otra. Los textos legales, qué secciones se imprimen
 * y qué renglones lleva cada firmante son propios de cada servicio: la firma simple y la avanzada se
 * apoyan en artículos distintos del Código de Comercio y su evidencia evoluciona por separado.
 *
 * Este archivo vive junto a `fonts/` y `assets/` porque `__dirname` es lo que resuelve sus rutas
 * tanto en `src/` como en `dist/` (nest-cli.json las copia al build).
 */

const BORDER_COLOR = '#000000';
const MUTED_TEXT_COLOR = '#333333';

/** Ancho de los banners de guiones (`----Firmas----`) del layout de referencia. */
const MONO_BANNER_WIDTH = 70;

/** Ancho de la columna de etiquetas de las tablas informativas. */
const LABEL_COLUMN_WIDTH = 115;

/**
 * Tipografías de las plantillas de referencia: **Lato** para el texto corrido y **JetBrains Mono**
 * para las tablas informativas y los separadores de guiones, que dependen del ancho fijo por
 * carácter para alinearse.
 *
 * Los .ttf viven en este módulo y no en node_modules, y nest-cli.json los copia a `dist/`. Declara
 * las cuatro variantes de cada familia porque pdfmake exige el diccionario completo: pedir
 * `bold: true` sobre una familia que sólo declara `normal` revienta en runtime.
 */
export const SHEET_FONT_DESCRIPTORS: TFontDictionary = {
  Lato: {
    normal: path.join(__dirname, 'fonts', 'Lato', 'Lato-Regular.ttf'),
    bold: path.join(__dirname, 'fonts', 'Lato', 'Lato-Bold.ttf'),
    italics: path.join(__dirname, 'fonts', 'Lato', 'Lato-Italic.ttf'),
    bolditalics: path.join(__dirname, 'fonts', 'Lato', 'Lato-BoldItalic.ttf'),
  },
  JetBrainsMono: {
    normal: path.join(
      __dirname,
      'fonts',
      'JetBrainsMono',
      'JetBrainsMono-Regular.ttf',
    ),
    bold: path.join(
      __dirname,
      'fonts',
      'JetBrainsMono',
      'JetBrainsMono-Bold.ttf',
    ),
    italics: path.join(
      __dirname,
      'fonts',
      'JetBrainsMono',
      'JetBrainsMono-Italic.ttf',
    ),
    bolditalics: path.join(
      __dirname,
      'fonts',
      'JetBrainsMono',
      'JetBrainsMono-BoldItalic.ttf',
    ),
  },
};

/** Logo "Firmalo — by Datalo" del encabezado (PNG, ver `assets/`). */
const LOGO_PATH = path.join(__dirname, 'assets', 'firmalo-logo.png');

/**
 * Isotipo (la marca sola, sin el texto) para el pie. Es un archivo aparte y no un recorte del
 * logo: en el lockup la "C" hace de "o" de "Firmalo", así que recortarla siempre arrastra un
 * pedazo de la letra anterior.
 */
const ISOTYPE_PATH = path.join(__dirname, 'assets', 'firmalo-isotipo.png');

/** Estilos compartidos por las dos hojas. */
export const SHEET_STYLES: StyleDictionary = {
  mono: { font: 'JetBrainsMono', fontSize: 8.5 },
  sectionTitle: { font: 'Lato', fontSize: 10.5, margin: [0, 4, 0, 6] },
  legal: { font: 'Lato', fontSize: 10, lineHeight: 1.25 },
  footerText: {
    font: 'Lato',
    fontSize: 7,
    color: MUTED_TEXT_COLOR,
    lineHeight: 1.15,
  },
};

export const SHEET_DEFAULT_STYLE = {
  font: 'Lato',
  fontSize: 10,
  lineHeight: 1.2,
};

/** Márgenes de página que dejan sitio al encabezado y al pie, que se repiten en cada página. */
export const SHEET_PAGE_MARGINS: [number, number, number, number] = [
  50, 92, 50, 100,
];

/**
 * Arma el encabezado de las dos plantillas: logo a la izquierda y el tipo de firma a la derecha, en
 * monoespaciada. Se declara como `header` de pdfmake y no como contenido para que se repita en todas
 * las páginas, porque la hoja crece con el número de firmantes.
 */
export function buildSheetHeader(signatureTypeLabel: string): ContentColumns {
  return {
    margin: [50, 28, 50, 0],
    columns: [
      brandColumn(LOGO_PATH, [140, 58]),
      {
        width: '*',
        text: signatureTypeLabel,
        style: 'mono',
        alignment: 'right',
        margin: [0, 16, 0, 0],
      },
    ],
  };
}

const FOOTER_LEGAL_TEXT =
  'La información presentada en el presente documento no ha sido modificada. Escanea el código ' +
  'para verificar la integridad del documento y descargar los archivos oficiales que forman ' +
  'parte de la cadena de trazabilidad e integridad del proceso de firmado necesarios para un ' +
  'juicio.';

const FOOTER_XML_NOTE = 'Este documento es una representación visual de un XML';

/**
 * Arma el pie de las dos plantillas: código QR a la pantalla pública de verificación, la leyenda
 * legal sobre la descarga de los archivos oficiales, y la marca.
 *
 * El QR apunta a `verificationUrl` —la vista pública del documento, la única consultable sin
 * sesión— para que quien tenga la hoja impresa pueda comprobar su integridad y descargar los
 * archivos de la cadena de trazabilidad.
 */
export function buildSheetFooter(verificationUrl: string): ContentColumns {
  return {
    margin: [50, 12, 50, 0],
    columns: [
      { width: 'auto', qr: verificationUrl, fit: 66, foreground: '#000000' },
      {
        width: '*',
        text: FOOTER_LEGAL_TEXT,
        style: 'footerText',
        alignment: 'justify',
        margin: [10, 2, 10, 0],
      },
      {
        width: 138,
        columns: [
          {
            width: '*',
            text: FOOTER_XML_NOTE,
            style: 'footerText',
            alignment: 'justify',
            margin: [0, 2, 8, 0],
          },
          brandColumn(ISOTYPE_PATH, [40, 40]),
        ],
      },
    ],
  };
}

/**
 * Arma una columna con una imagen de marca. pdfmake acepta imágenes como columna, pero su tipo
 * `Column` publicado no las contempla: de ahí la conversión, acotada a este único lugar en vez de
 * repartida por cada uso.
 */
function brandColumn(image: string, fit: [number, number]): Column {
  return { width: 'auto', image, fit } as unknown as Column;
}

/**
 * Arma una tabla informativa de dos columnas (etiqueta / valor) con el borde fino de las plantillas.
 * Es el formato de las tres secciones —Documento, Constancia NOM-151 y una por cada firmante— y lo
 * que les da su separación visual.
 */
export function buildInfoTable(rows: string[][], marginTop = 0): ContentTable {
  return {
    margin: [0, marginTop, 0, 0],
    table: {
      widths: [LABEL_COLUMN_WIDTH, '*'],
      // Una fila no se parte entre páginas: si lo hiciera, el valor continuaría en la página
      // siguiente sin su etiqueta al lado — un dato suelto en un documento legal. Pasa con la
      // firma en base64 de la hoja avanzada, que ocupa varios renglones.
      dontBreakRows: true,
      body: rows.map(([label, value]) => [
        { text: label, style: 'mono' },
        { text: value, style: 'mono' },
      ]) as Content[][],
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => BORDER_COLOR,
      vLineColor: () => BORDER_COLOR,
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
  };
}

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

/** `-------Firmas-------`: el título centrado entre guiones de las plantillas de referencia. */
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
