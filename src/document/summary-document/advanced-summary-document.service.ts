import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ContentTable, TDocumentDefinitions } from 'pdfmake/interfaces';
import { ConservationRecordInfo } from './conservation-record.util';
import {
  AdvancedSummaryDocumentInfo,
  AdvancedSummaryDocumentSigner,
} from './interfaces/advanced-summary-document.interface';
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
// Valores fijos de la tabla de cada firmante: describen el mecanismo, no al firmante. Compartidos
// con la vista pública de verificación, que tiene que decir exactamente lo mismo que esta hoja.
import {
  ADVANCED_SIGNATURE_BACKING_LABEL as SIGNATURE_BACKING_LABEL,
  ADVANCED_SIGNATURE_TYPE_LABEL as SIGNATURE_TYPE_LABEL,
} from './signature-legal-text';

/** Tipo de firma que rotula el encabezado, en la nomenclatura de la plantilla de referencia. */
const SIGNATURE_TYPE_HEADING = 'Firma_Electrónica_Avanzada';

/** Banner de guiones que abre la hoja. */
const BRAND_BANNER = 'Firmalo_FIEL';

/** Longitud de renglón para partir la firma en base64. 64 es la de RFC 2045 y entra de sobra en la celda. */
const SIGNATURE_LINE_LENGTH = 64;

/**
 * Fundamento legal de la firma avanzada, tomado de la plantilla de referencia. Es OTRO texto que
 * el de la hoja simple —y no una variante del mismo—: la firma avanzada se sostiene en el artículo
 * 97 y en el certificado del SAT.
 */
const LEGAL_TEXT =
  'Este documento fue firmado electrónicamente conforme a lo dispuesto en los artículos 89, ' +
  '90, 93 y 97 del Código de Comercio en relación con firmas electrónicas y mensajes de datos, ' +
  'gozando de presunción legal de atribución. Por tratarse de una Firma Electrónica Avanzada o ' +
  'fiable, generada mediante un certificado emitido por el Servicio de Administración ' +
  'Tributaria, este documento goza de no repudio y cada firma electrónica es considerada como ' +
  'una certeza plena en juicio.';

/** Introducción de la sección "Firmas" (plantilla de referencia). */
const SIGNATURES_INTRO_TEXT =
  'Para la generación de estas firmas se utiliza el certificado emitido por el SAT, el cual ' +
  'vincula de manera exclusiva e inequívoca al firmante con los Datos de Creación de la Firma. ' +
  'Conforme a los requisitos del artículo 97 del Código de Comercio, este mecanismo permite ' +
  'acreditar la identidad del firmante.';

/**
 * Tabla de la Constancia de Conservación (NOM-151), con los renglones de la plantilla.
 *
 * Solo "EMITIDO" se llena hoy. El DN del certificado (TSA) y el número de serie del sello viajan
 * únicamente dentro del token RFC 3161 del PSC y nadie los expone por separado — ver la nota de
 * `toConservationRecord`, que es donde está el detalle. Los renglones se imprimen igual, vacíos:
 * la tabla es parte de la plantilla y desaparecerla del documento legal sería peor.
 */
function buildConservationRecordRows(
  record: ConservationRecordInfo | null | undefined,
): string[][] {
  return [
    ['Certificado (TSA)', record?.tsaCertificate ?? ''],
    ['NUMERO DE SERIE', record?.serialNumber ?? ''],
    ['EMITIDO', formatSheetDate(record?.issuedAt)],
  ];
}

/**
 * Hoja de evidencia de FIRMA AVANZADA (e.firma del SAT).
 *
 * Gemela de `SummaryDocumentService` y deliberadamente independiente de él: comparten la plomería
 * de render y las piezas de layout (`sheet-rendering.ts`) pero ni un solo texto legal, porque la
 * evidencia de una firma simple y la de una avanzada acreditan cosas distintas y van a evolucionar
 * por separado. Cambiar una no puede arrastrar a la otra.
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
        buildInfoTable(
          buildConservationRecordRows(document.conservationRecord),
        ),
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

  /** Una tabla por firmante, con los campos de la plantilla de referencia. */
  private buildSignerTable(
    signer: AdvancedSummaryDocumentSigner,
    index: number,
  ): ContentTable {
    return buildInfoTable(
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
      ],
      index === 0 ? 0 : 12,
    );
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
