import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  Content,
  ContentTable,
  TDocumentDefinitions,
} from 'pdfmake/interfaces';
import {
  AdvancedSummaryDocumentInfo,
  AdvancedSummaryDocumentSigner,
} from './interfaces/advanced-summary-document.interface';
import {
  BRAND_COLOR,
  dashBanner,
  formatSheetDate,
  renderSheetPdf,
} from './sheet-rendering';

const LABEL_COLUMN_WIDTH = 115;
const BORDER_COLOR = '#000000';

/** Longitud de renglón para partir la firma en base64. 64 es la de RFC 2045, y a 8pt en Courier entra de sobra en la celda. */
const SIGNATURE_LINE_LENGTH = 64;

/**
 * Fundamento legal de la firma avanzada, tomado del documento de referencia. Es OTRO texto que el
 * de la hoja simple —y no una variante del mismo—: la firma avanzada se sostiene en el artículo 97
 * y en el certificado del SAT, no en el encadenamiento de hashes del Audit Trail.
 */
const LEGAL_TEXT =
  'Este documento fue firmado electrónicamente conforme a lo dispuesto en los artículos 89, ' +
  '90, 93 y 97 del Código de Comercio en relación con firmas electrónicas y mensajes de datos, ' +
  'gozando de presunción legal de atribución. Por tratarse de una Firma Electrónica Avanzada o ' +
  'fiable, generada mediante un certificado emitido por el Servicio de Administración ' +
  'Tributaria, este documento goza de no repudio y cada firma electrónica es considerada como ' +
  'una certeza plena en juicio.';

/** Introducción de la sección "Firmas" (documento de referencia). */
const SIGNATURES_INTRO_TEXT =
  'Para la generación de estas firmas se utiliza el certificado emitido por el SAT, el cual ' +
  'vincula de manera exclusiva e inequívoca al firmante con los Datos de Creación de la Firma. ' +
  'Conforme a los requisitos del artículo 97 del Código de Comercio, este mecanismo permite ' +
  'acreditar la identidad del firmante.';

const FOOTER_TEXT =
  'La información presentada en el presente documento no ha sido modificada. Escanea el código ' +
  'para verificar la integridad del documento y descargar los archivos oficiales que forman ' +
  'parte de la cadena de trazabilidad e integridad del proceso de firmado necesarios para un ' +
  'juicio.';

const FOOTER_NOTE = 'Este documento es una representación visual de un XML';

/** Valores fijos de la tabla de cada firmante: describen el mecanismo, no al firmante. */
const SIGNATURE_TYPE_LABEL = 'Firma Electronica Avanzada';
const SIGNATURE_BACKING_LABEL =
  'Certificado emitido por el Sistema de Administración Tributaria PSC (Art. 97 del Código de Comercio)';

/**
 * Renglones de la constancia NOM-151. Se imprimen SIN valor a propósito (ver historia "Crear hoja
 * de evidencia específica para firma avanzada"): el sellado con el PSC ya existe —`SealApiService`
 * guarda el timestamp TSA y la constancia en `document_seals`— pero todavía no se decide cómo se
 * refleja acá, así que la tabla queda armada y vacía en vez de inventar datos o desaparecer del
 * documento legal.
 */
const NOM151_ROW_LABELS = ['Certificado (TSA)', 'NUMERO DE SERIE', 'EMITIDO'];

/**
 * Hoja de evidencia de FIRMA AVANZADA (e.firma del SAT).
 *
 * Gemela de `SummaryDocumentService` y deliberadamente independiente de él: comparten la plomería
 * de render (`sheet-rendering.ts`) pero ni un solo texto ni una sola tabla, porque la evidencia de
 * una firma simple y la de una avanzada acreditan cosas distintas y van a evolucionar por separado
 * (la NOM-151 de acá, por ejemplo, ya tiene fecha de cambio). Cambiar una no puede arrastrar a la
 * otra.
 *
 * No lee ni escribe nada por sí misma: recibe `document` y `signers` ya resueltos por el caller y
 * devuelve el PDF en memoria.
 */
@Injectable()
export class AdvancedSummaryDocumentService {
  private readonly logger = new Logger(AdvancedSummaryDocumentService.name);

  async generateAdvancedSummaryPdf(
    document: AdvancedSummaryDocumentInfo,
    signers: AdvancedSummaryDocumentSigner[],
  ): Promise<Buffer> {
    try {
      return await renderSheetPdf(this.buildDocDefinition(document, signers));
    } catch (error) {
      this.logger.error(
        `Error generando la hoja de evidencia de firma avanzada del documento ${document.id}: ${error}`,
      );
      throw new InternalServerErrorException(
        `Error generando la hoja de evidencia de firma avanzada del documento: ${error}`,
      );
    }
  }

  private buildDocDefinition(
    document: AdvancedSummaryDocumentInfo,
    signers: AdvancedSummaryDocumentSigner[],
  ): TDocumentDefinitions {
    return {
      pageSize: 'A4',
      pageMargins: [50, 70, 50, 110],
      defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.15 },
      styles: {
        mono: { font: 'Courier', fontSize: 9 },
        brand: { font: 'Roboto', bold: true, fontSize: 18, color: BRAND_COLOR },
        brandSubtitle: { fontSize: 8, color: '#666666' },
        sectionTitle: { bold: true, fontSize: 11, margin: [0, 4, 0, 6] },
        footerText: { fontSize: 7, color: '#333333', lineHeight: 1.1 },
      },
      // El título y el pie van como header/footer (y no como contenido) para que se repitan en
      // cada página: la hoja crece con el número de firmantes, y la de referencia los muestra en
      // todas sus páginas.
      header: (): Content => ({
        margin: [50, 24, 50, 0],
        columns: [
          {
            width: '*',
            stack: [
              { text: 'Firmalo', style: 'brand', fontSize: 14 },
              { text: '— by Datalo', style: 'brandSubtitle' },
            ],
          },
          {
            width: 'auto',
            text: 'Firma_Electrónica_Avanzada',
            style: 'mono',
            alignment: 'right',
            margin: [0, 6, 0, 0],
          },
        ],
      }),
      footer: (): Content => ({
        margin: [50, 10, 50, 0],
        columns: [
          {
            width: 'auto',
            qr: document.verificationUrl ?? document.id,
            fit: 60,
            foreground: BRAND_COLOR,
          },
          {
            width: '*',
            text: FOOTER_TEXT,
            style: 'footerText',
            alignment: 'justify',
            margin: [8, 0, 8, 0],
          },
          {
            width: 110,
            stack: [
              { text: FOOTER_NOTE, style: 'footerText', alignment: 'justify' },
              {
                text: 'Firmalo',
                style: 'brand',
                fontSize: 10,
                margin: [0, 4, 0, 0],
              },
            ],
          },
        ],
      }),
      content: [
        { text: dashBanner('Firmalo_FIEL'), style: 'mono' },
        { text: LEGAL_TEXT, alignment: 'justify', margin: [0, 10, 0, 10] },
        { text: 'Información del Documento.', style: 'sectionTitle' },
        this.buildTable(this.buildDocumentInfoRows(document)),
        {
          text: 'Información de la Constancia de Conservación (NOM-151)',
          style: 'sectionTitle',
          margin: [0, 14, 0, 6],
        },
        this.buildTable(NOM151_ROW_LABELS.map((label) => [label, ''])),
        {
          text: dashBanner('Firmas'),
          style: 'mono',
          margin: [0, 18, 0, 10],
        },
        {
          text: SIGNATURES_INTRO_TEXT,
          alignment: 'justify',
          margin: [0, 0, 0, 10],
        },
        ...signers.map((signer, index) => this.buildSignerTable(signer, index)),
      ],
    };
  }

  /** Mismos campos y orden que el documento de referencia — sin "Cifrado", que es propio de la hoja simple. */
  private buildDocumentInfoRows(
    document: AdvancedSummaryDocumentInfo,
  ): string[][] {
    return [
      ['ID', document.id],
      ['Nombre del documento', document.documentName],
      ['Hash', document.hash],
      ['No de paginas', String(document.totalPages)],
      ['Creado por', document.createdBy],
    ];
  }

  /**
   * Una tabla por firmante (no un bloque de texto como en la hoja simple): es lo que pide el
   * documento de referencia, y además evita que la firma en base64 —el valor más largo de la
   * hoja— se mezcle visualmente con los demás campos.
   */
  private buildSignerTable(
    signer: AdvancedSummaryDocumentSigner,
    index: number,
  ): ContentTable {
    return this.buildTable(
      [
        ['Nombre', signer.name],
        ['Tipo de Firma', SIGNATURE_TYPE_LABEL],
        ['IP', signer.ipAddress],
        ['Sustentada', SIGNATURE_BACKING_LABEL],
        [
          'Número de Serie del Certificado',
          signer.certificateSerialNumber ?? '',
        ],
        ['Firma Electrónica', this.wrapSignature(signer.electronicSignature)],
        ['Fecha de Firma', formatSheetDate(signer.signedAt)],
        ['Geo Loc', signer.geoLocation ?? ''],
      ],
      index === 0 ? 0 : 12,
    );
  }

  /** Tabla de dos columnas (etiqueta / valor) con el borde fino del documento de referencia. */
  private buildTable(rows: string[][], marginTop = 0): ContentTable {
    return {
      margin: [0, marginTop, 0, 0],
      table: {
        widths: [LABEL_COLUMN_WIDTH, '*'],
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

  /**
   * La firma en base64 es una sola "palabra" de varios cientos de caracteres: sin puntos de corte,
   * pdfmake la desborda fuera de la celda en vez de ajustarla. Partirla en renglones fijos la deja
   * dentro de la tabla y legible, que es para lo que está impresa.
   */
  private wrapSignature(signature: string | null | undefined): string {
    if (!signature) {
      return '';
    }

    return (
      signature.match(new RegExp(`.{1,${SIGNATURE_LINE_LENGTH}}`, 'g')) ?? []
    ).join('\n');
  }
}
