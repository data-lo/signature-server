import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { TDocumentDefinitions } from 'pdfmake/interfaces';
import {
  SummaryDocumentInfo,
  SummaryDocumentSigner,
} from './interfaces/summary-document.interface';
import {
  buildInfoTable,
  buildSheetFooter,
  buildSheetHeader,
  dashBanner,
  formatSheetDate,
  renderSheetPdf,
  SHEET_DEFAULT_STYLE,
  SHEET_PAGE_MARGINS,
  SHEET_STYLES,
} from './sheet-rendering';

/** Tipo de firma que rotula el encabezado, en la nomenclatura de la plantilla de referencia. */
const SIGNATURE_TYPE_HEADING = 'Firma_Digital_Simple';

/** Banner de guiones que abre la hoja. */
const BRAND_BANNER = 'Firmalo_Grafo';

/**
 * Fundamento legal de la firma simple (plantilla "Firmalo Hoja de Firmas SIMPLE"). La firma
 * avanzada tiene su propia hoja, con su propio fundamento — ver `AdvancedSummaryDocumentService`.
 */
const LEGAL_TEXT =
  'Este documento fue firmado electrónicamente conforme a lo dispuesto en los artículos 89, 90 y ' +
  '93 del Código de Comercio en relación con firmas electrónicas y mensajes de datos, gozando de ' +
  'presunción legal de atribución y conserva plena validez jurídica. La integridad de este ' +
  'documento está respaldada al integrar una constancia de conservación emitida por un PSC ' +
  'debidamente acreditado por la Secretaría de Economía. Esta modalidad de firma no goza de ' +
  'garantía de no repudio. Para actos que requieran dicha garantía, utiliza Firmalo Fiel.';

/** Introducción de la sección "Firmas" (plantilla de referencia). */
const SIGNATURES_INTRO_TEXT =
  'Para la generación de estas firmas se implementan mecanismos de verificación de identidad, ' +
  'incluyendo código de un solo uso (OTP), prueba de vida o comparación biométrica. Estos ' +
  'elementos permiten acreditar la identidad de los firmantes y sustentan la atribución del ' +
  'mensaje de datos en términos de los artículos 89, 90 y 93 del Código de Comercio.';

/** Valores fijos de la tabla de cada firmante: describen el mecanismo, no al firmante. */
const SIGNATURE_TYPE_LABEL = 'Digital Simple';
const SIGNATURE_BACKING_LABEL =
  'Firma Electrónica Simple (Arts. 89, 90 y 93 del Código de Comercio)';

/**
 * Renglones de la constancia NOM-151. En esta hoja se imprimen SIEMPRE vacíos: el sellado ante el
 * PSC solo corre para documentos de firma AVANZADA (`sealAdvancedSignatures` filtra por firmantes
 * con e.firma), así que un documento de firma simple no tiene constancia que mostrar.
 *
 * La tabla se imprime igual porque es parte de la plantilla de referencia: quitarla del documento
 * legal sería peor que mostrarla sin llenar.
 */
const NOM151_ROW_LABELS = ['Certificado (TSA)', 'NUMERO DE SERIE', 'EMITIDO'];

@Injectable()
export class SummaryDocumentService {
  private readonly logger = new Logger(SummaryDocumentService.name);

  /**
   * Genera la hoja de evidencia de FIRMA SIMPLE (info del documento + constancia de conservación +
   * detalle de cada firmante), replicando la plantilla de referencia "Firmalo Hoja de Firmas".
   *
   * No lee ni escribe nada por sí misma — recibe `document` y `signers` ya resueltos por el caller
   * (p.ej. `attachSignaturesSheet` en document.service.ts) y retorna el PDF en memoria.
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
      pageMargins: SHEET_PAGE_MARGINS,
      defaultStyle: SHEET_DEFAULT_STYLE,
      styles: SHEET_STYLES,
      header: () => buildSheetHeader(SIGNATURE_TYPE_HEADING),
      footer: () => buildSheetFooter(document.verificationUrl ?? document.id),
      content: [
        { text: dashBanner(BRAND_BANNER), style: 'mono' },
        {
          text: LEGAL_TEXT,
          style: 'legal',
          alignment: 'justify',
          margin: [0, 10, 0, 10],
        },
        { text: 'Información del Documento.', style: 'sectionTitle' },
        buildInfoTable(this.buildDocumentInfoRows(document)),
        {
          text: 'Información de la Constancia de Conservación (NOM-151)',
          style: 'sectionTitle',
          margin: [0, 14, 0, 6],
        },
        buildInfoTable(NOM151_ROW_LABELS.map((label) => [label, ''])),
        {
          text: dashBanner('Firmas'),
          style: 'mono',
          margin: [0, 18, 0, 10],
        },
        {
          text: SIGNATURES_INTRO_TEXT,
          style: 'legal',
          alignment: 'justify',
          margin: [0, 0, 0, 10],
        },
        ...signers.map((signer, index) => this.buildSignerTable(signer, index)),
      ],
    };
  }

  /** Mismos campos y orden que la plantilla de referencia. */
  private buildDocumentInfoRows(document: SummaryDocumentInfo): string[][] {
    return [
      ['ID', document.id],
      ['Nombre del documento', document.documentName],
      ['Hash', document.hash],
      ['No de paginas', String(document.totalPages)],
      ['Creado por', document.createdBy],
    ];
  }

  /** Una tabla por firmante, con los campos de la plantilla de referencia. */
  private buildSignerTable(signer: SummaryDocumentSigner, index: number) {
    return buildInfoTable(
      [
        ['Nombre', signer.name],
        ['Tipo de Firma', SIGNATURE_TYPE_LABEL],
        ['IP', signer.ipAddress],
        ['Sustentada', SIGNATURE_BACKING_LABEL],
        ['OTP CODE', signer.otpCode ?? ''],
        ['Fecha de Firma', formatSheetDate(signer.signedAt)],
      ],
      index === 0 ? 0 : 12,
    );
  }
}
