import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
// El proyecto no tiene esModuleInterop habilitado (ver tsconfig.json) y pdfmake exporta la
// clase vía `module.exports = PdfPrinter` (CommonJS puro, sin __esModule) — `import ... from`
// se transpilaría a `.default`, que no existe, y rompe en runtime. `import = require` es la
// forma segura de consumir un `export =` bajo ese tsconfig.
import PdfPrinter = require('pdfmake');
import {
  Content,
  TDocumentDefinitions,
  TFontDictionary,
} from 'pdfmake/interfaces';
import * as path from 'path';
import {
  SummaryDocumentInfo,
  SummaryDocumentSigner,
} from './interfaces/summary-document.interface';

const BRAND_COLOR = '#1a56db';
const MONO_BANNER_WIDTH = 70;
const DOC_INFO_LABEL_WIDTH = 22;
const SIGNER_LABEL_WIDTH = 12;

/**
 * Roboto (proporcional, para el texto legal) viene de node_modules/pdfmake — npm no publica los
 * .ttf de sus ejemplos, así que se copian una sola vez a este módulo (ver fonts/Roboto/*.ttf) y
 * se registran en nest-cli.json como asset (*.ttf) para que el build los incluya en dist/.
 * Courier es una de las 14 fuentes estándar de PDF: PDFKit la resuelve por nombre sin necesitar
 * un archivo .ttf.
 */
const FONT_DESCRIPTORS: TFontDictionary = {
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

/** Texto legal fijo para FIRMA_ELECTRONICA_SIMPLE (ver plantilla de referencia) — es el único tipo de firma con lógica implementada hoy (SIGNATURE_TYPE_ENUM.FIEL es solo modelo de datos). */
const LEGAL_TEXT =
  'Este documento fue firmado electrónicamente conforme a las disposiciones legales ' +
  'establecidas en los artículos 89, 89 Bis, 90 y 93 del Código de Comercio, con relación a ' +
  'firmas electrónicas y mensajes de datos, gozando de presunción de atribución. La ' +
  'integridad de este documento está respaldada por el encadenamiento de su huella digital ' +
  '(hash) en el registro de auditoría (Audit Trail) de Firmalo lo que permite detectar ' +
  'cualquier alteración posterior a la firma.';

@Injectable()
export class SummaryDocumentService {
  private readonly logger = new Logger(SummaryDocumentService.name);

  /**
   * Genera la hoja resumen del proceso de firma (info del documento + detalle de cada
   * firmante), replicando la plantilla de referencia "Firmalo Hoja de Firmas". No lee ni
   * escribe nada por sí misma — recibe `document` y `signers` ya resueltos por el caller
   * (p.ej. finalizeSignedDocument en document.service.ts) y retorna el PDF en memoria.
   */
  async generateSummaryPdf(
    document: SummaryDocumentInfo,
    signers: SummaryDocumentSigner[],
  ): Promise<Buffer> {
    try {
      const printer = new PdfPrinter(FONT_DESCRIPTORS);
      const docDefinition = this.buildDocDefinition(document, signers);
      const pdfDoc = printer.createPdfKitDocument(docDefinition);

      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
        pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
        pdfDoc.on('error', reject);
        pdfDoc.end();
      });
    } catch (error) {
      this.logger.error(
        `Error generando la hoja resumen del documento ${document.id}: ${error}`,
      );
      throw new InternalServerErrorException(
        `Error generando la hoja resumen del documento: ${error}`,
      );
    }
  }

  private buildDocDefinition(
    document: SummaryDocumentInfo,
    signers: SummaryDocumentSigner[],
  ): TDocumentDefinitions {
    return {
      pageSize: 'A4',
      pageMargins: [50, 50, 50, 60],
      defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.15 },
      styles: {
        mono: { font: 'Courier', fontSize: 9 },
        brand: { font: 'Roboto', bold: true, fontSize: 18, color: BRAND_COLOR },
        brandSubtitle: { fontSize: 8, color: '#666666' },
        sectionTitle: { bold: true, fontSize: 11, margin: [0, 4, 0, 6] },
      },
      content: [
        { text: 'Firmalo', style: 'brand' },
        {
          text: '— by Datalo',
          style: 'brandSubtitle',
          margin: [0, 0, 0, 14],
        },
        { text: this.dashBanner('Firmalo_Grafo'), style: 'mono' },
        {
          text: this.dashBanner('Firma_Electronica_Simple'),
          style: 'mono',
          margin: [0, 0, 0, 10],
        },
        { text: LEGAL_TEXT, alignment: 'justify', margin: [0, 0, 0, 10] },
        { text: 'Información del Documento.', style: 'sectionTitle' },
        {
          text: this.buildDocumentInfoLines(document).join('\n'),
          style: 'mono',
        },
        {
          text: this.dashBanner('Firmas'),
          style: 'mono',
          margin: [0, 16, 0, 10],
        },
        ...signers.flatMap((signer, index) =>
          this.buildSignerBlock(signer, index),
        ),
        {
          margin: [0, 24, 0, 0],
          columns: [
            {
              width: 'auto',
              qr: document.verificationUrl ?? document.id,
              fit: 90,
              foreground: BRAND_COLOR,
            },
            {
              width: '*',
              text: '',
            },
            {
              width: 'auto',
              stack: [
                { text: 'Firmalo', style: 'brand', fontSize: 12 },
                { text: 'by Datalo', style: 'brandSubtitle' },
              ],
              alignment: 'right',
            },
          ],
        },
      ],
    };
  }

  /** Renglones "label   valor" en Courier, alineados a DOC_INFO_LABEL_WIDTH — mismos campos y orden que la plantilla de referencia. */
  private buildDocumentInfoLines(document: SummaryDocumentInfo): string[] {
    return [
      this.padLabel('ID', document.id, DOC_INFO_LABEL_WIDTH),
      this.padLabel(
        'Nombre del documento',
        document.documentName,
        DOC_INFO_LABEL_WIDTH,
      ),
      this.padLabel('Hash', document.hash, DOC_INFO_LABEL_WIDTH),
      this.padLabel('Cifrado', document.cipher, DOC_INFO_LABEL_WIDTH),
      this.padLabel(
        'No de paginas',
        String(document.totalPages),
        DOC_INFO_LABEL_WIDTH,
      ),
      this.padLabel('Creado por', document.createdBy, DOC_INFO_LABEL_WIDTH),
    ];
  }

  /** Bloque "Nombre / RFC / IP / OTP CODE / fecha / Geo" de un firmante — mismos campos que la plantilla de referencia. */
  private buildSignerBlock(
    signer: SummaryDocumentSigner,
    index: number,
  ): Content[] {
    const lines = [
      this.padLabel('Nombre', signer.name, SIGNER_LABEL_WIDTH),
      this.padLabel('RFC', signer.rfc ?? '', SIGNER_LABEL_WIDTH),
      this.padLabel('IP', signer.ipAddress, SIGNER_LABEL_WIDTH),
      this.padLabel('OTP CODE', signer.otpCode ?? '', SIGNER_LABEL_WIDTH),
      this.padLabel(
        'fecha',
        this.formatDate(signer.signedAt),
        SIGNER_LABEL_WIDTH,
      ),
      this.padLabel('Geo', signer.geoLocation ?? '', SIGNER_LABEL_WIDTH),
    ];

    return [
      {
        text: lines.join('\n'),
        style: 'mono',
        margin: [0, index === 0 ? 0 : 14, 0, 0],
      },
    ];
  }

  /** "label" + espacios hasta `width` + "valor" — replica el layout de columna fija de la plantilla. Si el label ya excede `width`, se agrega un solo espacio en vez de truncar el valor. */
  private padLabel(label: string, value: string, width: number): string {
    const padding = ' '.repeat(Math.max(width - label.length, 1));
    return `${label}${padding}${value ?? ''}`;
  }

  private dashBanner(label: string, width = MONO_BANNER_WIDTH): string {
    const dashes = Math.max(width - label.length, 0);
    const left = Math.floor(dashes / 2);
    const right = dashes - left;
    return `${'-'.repeat(left)}${label}${'-'.repeat(right)}`;
  }

  private formatDate(value: Date | string | null | undefined): string {
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
}
