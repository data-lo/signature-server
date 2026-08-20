import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import {
  SummaryDocumentInfo,
  SummaryDocumentSigner,
} from './interfaces/summary-document.interface';
import {
  BRAND_COLOR,
  dashBanner,
  formatSheetDate,
  padLabel,
  renderSheetPdf,
} from './sheet-rendering';

const DOC_INFO_LABEL_WIDTH = 22;
const SIGNER_LABEL_WIDTH = 12;

/** Texto legal fijo para FIRMA_ELECTRONICA_SIMPLE (ver plantilla de referencia). La firma avanzada tiene su propia hoja, con su propio fundamento legal — ver `AdvancedSummaryDocumentService`. */
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
      return await renderSheetPdf(this.buildDocDefinition(document, signers));
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
        { text: dashBanner('Firmalo_Grafo'), style: 'mono' },
        {
          text: dashBanner('Firma_Electronica_Simple'),
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
          text: dashBanner('Firmas'),
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
      padLabel('ID', document.id, DOC_INFO_LABEL_WIDTH),
      padLabel(
        'Nombre del documento',
        document.documentName,
        DOC_INFO_LABEL_WIDTH,
      ),
      padLabel('Hash', document.hash, DOC_INFO_LABEL_WIDTH),
      padLabel('Cifrado', document.cipher, DOC_INFO_LABEL_WIDTH),
      padLabel(
        'No de paginas',
        String(document.totalPages),
        DOC_INFO_LABEL_WIDTH,
      ),
      padLabel('Creado por', document.createdBy, DOC_INFO_LABEL_WIDTH),
    ];
  }

  /** Bloque "Nombre / RFC / IP / OTP CODE / fecha / Geo" de un firmante — mismos campos que la plantilla de referencia. */
  private buildSignerBlock(
    signer: SummaryDocumentSigner,
    index: number,
  ): Content[] {
    const lines = [
      padLabel('Nombre', signer.name, SIGNER_LABEL_WIDTH),
      padLabel('RFC', signer.rfc ?? '', SIGNER_LABEL_WIDTH),
      padLabel('IP', signer.ipAddress, SIGNER_LABEL_WIDTH),
      padLabel('OTP CODE', signer.otpCode ?? '', SIGNER_LABEL_WIDTH),
      padLabel('fecha', formatSheetDate(signer.signedAt), SIGNER_LABEL_WIDTH),
      padLabel('Geo', signer.geoLocation ?? '', SIGNER_LABEL_WIDTH),
    ];

    return [
      {
        text: lines.join('\n'),
        style: 'mono',
        margin: [0, index === 0 ? 0 : 14, 0, 0],
      },
    ];
  }

}
