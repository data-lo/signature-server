import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  PDFDocument,
  PDFImage,
  PDFName,
  PDFPage,
  PDFNumber,
  PDFString,
  StandardFonts,
  rgb,
  degrees,
  PDFHexString,
} from 'pdf-lib';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SignatureCoordinates } from './interfaces/signature-coordinates.interface';

// Posición por defecto: esquina inferior derecha de una página A4 (595 x 842 pt)

// Para ajustar los limites solo hayq ue modificar las tres constantes siguientes. Si la firma queda fuera de estos rangos, se normaliza a DEFAULT_SIGNATURE_SIZE.
// Tamaño al que se normaliza la firma cuando está fuera de rango (puntos PDF)
const DEFAULT_SIGNATURE_SIZE = { width: 200, height: 80 };

// Umbral mínimo: firmas más pequeñas que esto se consideran demasiado chicas
const MIN_SIGNATURE_SIZE = { width: 60, height: 24 };

// Umbral máximo: firmas más grandes que esto se consideran demasiado grandes
const MAX_SIGNATURE_SIZE = { width: 320, height: 128 };

/**
 * Borde blanco que se dibuja alrededor de un código QR estampado ("zona de silencio").
 *
 * La norma QR exige un margen libre alrededor del código; sin él, el texto del documento pegado al
 * código impide leerlo — medido: con texto a 0pt el código NO se decodifica a 150 DPI, y con 2pt
 * de separación sí. El PNG se genera sin margen propio a propósito (así el código aprovecha todo
 * el lado de la caja y sus módulos quedan lo más grandes posible), de modo que el margen se pinta
 * acá, POR FUERA del código y no a costa de su tamaño.
 */
const QR_QUIET_ZONE_PT = 4;

/**
 * Lado mínimo, en puntos, para que un QR estampado siga siendo escaneable.
 *
 * Medido con un decodificador real sobre la página rasterizada: a 80pt el código se lee a 150 y
 * 300 DPI; a 24pt (el mínimo que admite una caja de firma) no se lee a ninguna resolución, porque
 * sus módulos quedan en ~0.12mm. Por debajo de este umbral se registra una advertencia en vez de
 * estampar en silencio un código que nadie va a poder leer.
 */
const QR_MIN_SCANNABLE_SIDE_PT = 60;

// Rutas donde puede encontrarse el perfil ICC sRGB (probadas en orden)
const SRGB_ICC_PATHS = [
  path.join(__dirname, 'resources', 'sRGB2014.icc'),
  path.join(__dirname, 'resources', 'sRGB_v4_ICC_preference_displayclass.icc'),
  path.join(__dirname, 'resources', 'sRGB_v4_ICC_preference.icc'),
  path.join(__dirname, 'resources', 'sRGB.icc'),
  '/usr/share/color/icc/sRGB.icc',
  '/usr/share/color/icc/colord/sRGB.icc',
];

function loadSrgbIccProfile(): Buffer | null {
  for (const iccPath of SRGB_ICC_PATHS) {
    try {
      return fs.readFileSync(iccPath);
    } catch {
      // siguiente ruta
    }
  }
  return null;
}

function buildXmpMetadata(): string {
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">\n` +
    `  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `    <rdf:Description rdf:about=""\n` +
    `        xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n` +
    `      <pdfaid:part>2</pdfaid:part>\n` +
    `      <pdfaid:conformance>B</pdfaid:conformance>\n` +
    `    </rdf:Description>\n` +
    `  </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>`
  );
}

@Injectable()
export class PdfSignatureService {
  private readonly logger = new Logger(PdfSignatureService.name);

  /**
   * Incrusta la imagen de firma en el documento PDF en las coordenadas indicadas
   * y serializa el resultado como PDF/A-2B (ISO 19005-2, nivel B).
   *
   * PDF/A-2B permite transparencias, lo que es necesario para firmas PNG con canal alfa.
   *
   *  1. Carga el PDF original desde el Buffer recibido para poder modificarlo en memoria.
   *
   *  2. Detecta el formato de la imagen (PNG) leyendo los primeros 4 bytes del Buffer,
   *     ya que pdf-lib requiere llamar a métodos distintos según el formato.
   *
   *  3. Incrusta la imagen en el documento PDF, lo que la registra como recurso interno
   *     del PDF antes de poder dibujarla en alguna página.
   *
   *  4. Selecciona la última página del documento como destino de la firma.
   *
   *  5. Resuelve el tamaño final de la firma: si width o height están fuera del rango
   *     [MIN_SIGNATURE_SIZE, MAX_SIGNATURE_SIZE], se normaliza a DEFAULT_SIGNATURE_SIZE.
   *
   *  6. Dibuja la imagen de firma en las coordenadas (x, y) con el tamaño resuelto.
   *     El origen (0,0) en PDF está en la esquina inferior izquierda.
   *     Se aplica la opacidad indicada en coordinates.opacity (default 1.0 = opaco).
   *
   *  7. Aplica conformidad PDF/A-2B: agrega metadatos XMP con pdfaid:part=2 /
   *     pdfaid:conformance=B y un OutputIntent con perfil ICC sRGB si está disponible.
   *
   *  8. Serializa el documento modificado a bytes y lo retorna como Buffer.
   *     Se usa useObjectStreams:false para máxima compatibilidad con validadores PDF/A.
   *
   * @param documentBuffer  PDF original como Buffer de bytes.
   * @param signatureBuffer Imagen de la firma (PNG) como Buffer de bytes.
   * @param coordinates     Posición y tamaño donde incrustar la firma en la página.
   * @param pageIndex       Página destino, 0-based (ver historia "Ubicación de firmas por
   *                        usuario"). Por defecto la última página, mismo comportamiento que
   *                        antes de que existiera soporte multipágina — ningún caller que no lo
   *                        pase explícitamente cambia de comportamiento.
   * @param options         `preserveAspectRatio` encaja la imagen dentro de la caja sin
   *                        deformarla, centrada. Lo usa el QR de la firma avanzada (ver más
   *                        abajo); las rúbricas siguen ocupando la caja completa, como siempre.
   * @returns               PDF firmado en formato PDF/A-2B como Buffer.
   */
  async mergeSignatureIntoPdf(
    documentBuffer: Buffer,
    signatureBuffer: Buffer,
    coordinates: SignatureCoordinates,
    pageIndex?: number,
    options?: { preserveAspectRatio?: boolean },
  ): Promise<Buffer> {
    // Paso 1: cargar el PDF original en memoria para poder modificarlo
    const pdfDoc: PDFDocument = await PDFDocument.load(documentBuffer);

    // Paso 2: detectar el formato de la imagen mediante los bytes del Buffer
    let signatureImage: PDFImage;
    const signatureBytes: Uint8Array = new Uint8Array(signatureBuffer);

    // Identificar PNG por su firma de bytes: 89 50 4E 47 (hexadecimal)
    const isPng: boolean =
      signatureBytes[0] === 0x89 &&
      signatureBytes[1] === 0x50 &&
      signatureBytes[2] === 0x4e &&
      signatureBytes[3] === 0x47;

    // Paso 3: incrustar la imagen en el PDF según su formato detectado
    if (isPng) {
      signatureImage = await pdfDoc.embedPng(signatureBuffer);
    } else {
      throw new BadRequestException(
        'FORMATO DE IMAGEN NO SOPORTADO. SOLO SE PERMITEN PNG',
      );
    }

    // Paso 4: seleccionar la página destino (por defecto la última, ver doc del parámetro)
    const pages = pdfDoc.getPages();
    const targetPage = pages[pageIndex ?? pages.length - 1] ?? pages[pages.length - 1];

    // Paso 5: resolver el tamaño final de la firma aplicando el resize automático si corresponde
    const drawSize = this.resolveSignatureSize(coordinates);

    // Paso 6: dibujar la firma en la página con las coordenadas, dimensiones y opacidad resueltas
    const placement = options?.preserveAspectRatio
      ? this.fitPreservingAspectRatio(signatureImage, coordinates, drawSize)
      : { x: coordinates.x, y: coordinates.y, ...drawSize };

    if (options?.preserveAspectRatio) {
      this.drawQuietZone(targetPage, placement);
    }

    targetPage.drawImage(signatureImage, {
      ...placement,
      opacity: coordinates.opacity ?? 1.0,
    });

    // Paso 7: aplicar conformidad PDF/A-2B (XMP metadata + OutputIntent sRGB)
    this.applyPdfA2bConformance(pdfDoc);

    // Paso 8: serializar sin object streams para máxima compatibilidad con validadores PDF/A
    const signedPdfBytes: Uint8Array = await pdfDoc.save({
      useObjectStreams: false,
    });
    return Buffer.from(signedPdfBytes);
  }

  /**
   * Agrega al documento los marcadores mínimos requeridos por PDF/A-2B:
   *  - Stream de metadatos XMP en el catálogo (pdfaid:part=2, pdfaid:conformance=B)
   *  - OutputIntent con perfil ICC sRGB (requerido para espacios de color dependientes del dispositivo)
   *
   * Si el perfil ICC no se encuentra, se emite una advertencia y se omite el OutputIntent.
   * El documento seguirá teniendo los metadatos XMP correctos, pero no será completamente
   * conforme hasta que se provea el perfil ICC.
   */
  private applyPdfA2bConformance(pdfDoc: PDFDocument): void {
    const xmpBytes = Buffer.from(buildXmpMetadata(), 'utf-8');
    const metadataStream = pdfDoc.context.stream(new Uint8Array(xmpBytes), {
      Type: PDFName.of('Metadata'),
      Subtype: PDFName.of('XML'),
      Length: PDFNumber.of(xmpBytes.length),
    });

    pdfDoc.catalog.set(
      PDFName.of('Metadata'),
      pdfDoc.context.register(metadataStream),
    );

    const id = PDFHexString.of(crypto.randomBytes(16).toString('hex'));
    pdfDoc.context.trailerInfo.ID = pdfDoc.context.obj([id, id]);

    const iccProfile = loadSrgbIccProfile();
    if (!iccProfile) {
      this.logger.warn(
        'Perfil ICC sRGB no encontrado. El OutputIntent será omitido y el documento ' +
          'no será completamente conforme con PDF/A-2B. Coloque sRGB.icc en ' +
          'src/shared/document-signing/resources/sRGB.icc',
      );
      return;
    }

    const iccProfileBytes = new Uint8Array(iccProfile);
    const iccStream = pdfDoc.context.stream(iccProfileBytes, {
      N: PDFNumber.of(3),
      Length: PDFNumber.of(iccProfileBytes.length),
    });
    const iccRef = pdfDoc.context.register(iccStream);
    const outputIntentObj = pdfDoc.context.obj({
      Type: PDFName.of('OutputIntent'),
      S: PDFName.of('GTS_PDFA1'),
      OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
      Info: PDFString.of('sRGB IEC61966-2.1'),
      DestOutputProfile: iccRef,
    });

    const outputIntentRef = pdfDoc.context.register(outputIntentObj);

    pdfDoc.catalog.set(
      PDFName.of('OutputIntents'),
      pdfDoc.context.obj([outputIntentRef]),
    );
  }

  /**
   * Convierte una posición en ratios 0-1 (ver historia "Ubicación de firmas por usuario") a
   * coordenadas absolutas en puntos PDF (origen inferior-izquierdo) contra el tamaño REAL de la
   * página destino — los ratios no sirven de nada sin saber el tamaño en puntos de ESA página
   * específica, que puede variar entre páginas de un mismo documento.
   *
   * `yRatio` se mide desde el borde SUPERIOR de la página (coincide con cómo el frontend mide la
   * posición del drop en el DOM), de ahí la resta contra `pageHeight`.
   *
   * `page` es 1-based; si viniera fuera de rango (no debería, ya validado al crear el
   * documento) se usa la última página como fallback en vez de lanzar.
   */
  async resolveRatioPosition(
    documentBuffer: Buffer,
    position: {
      page: number;
      xRatio: number;
      yRatio: number;
      widthRatio: number;
      heightRatio: number;
      opacity?: number;
    },
  ): Promise<{ coordinates: SignatureCoordinates; pageIndex: number }> {
    const pdfDoc = await PDFDocument.load(documentBuffer);
    const pages = pdfDoc.getPages();
    const pageIndex = Math.min(Math.max(position.page - 1, 0), pages.length - 1);
    const { width: pageWidth, height: pageHeight } = pages[pageIndex].getSize();

    return {
      pageIndex,
      coordinates: {
        x: position.xRatio * pageWidth,
        y: pageHeight - (position.yRatio + position.heightRatio) * pageHeight,
        width: position.widthRatio * pageWidth,
        height: position.heightRatio * pageHeight,
        opacity: position.opacity,
      },
    };
  }

  /**
   * Devuelve un PDF nuevo con las páginas de `documentBuffer` seguidas de las de `pagesBuffer`
   * (historia "Anexar hoja existente de información de firmas al documento final").
   *
   * Ninguno de los dos PDF de entrada se modifica: `copyPages` serializa las páginas del origen y
   * las incrusta en un documento destino recién creado, así que el documento firmado y la hoja
   * quedan intactos en sus buckets y esto solo produce una tercera copia. Tampoco se re-estampa ni
   * se recalcula nada del contenido: las firmas ya dibujadas viajan tal cual dentro de las páginas
   * copiadas, que es justo lo que pide el criterio de conservar la hoja con las firmas existentes.
   *
   * El resultado se serializa con la misma conformidad PDF/A-2B que el resto del servicio: la
   * versión definitiva que ve el usuario no puede ser menos archivable que la que la originó.
   */
  async appendPdfPages(
    documentBuffer: Buffer,
    pagesBuffer: Buffer,
  ): Promise<Buffer> {
    try {
      const mergedDoc = await PDFDocument.create();

      for (const source of [documentBuffer, pagesBuffer]) {
        const sourceDoc = await PDFDocument.load(source);
        const copiedPages = await mergedDoc.copyPages(
          sourceDoc,
          sourceDoc.getPageIndices(),
        );
        for (const page of copiedPages) {
          mergedDoc.addPage(page);
        }
      }

      this.applyPdfA2bConformance(mergedDoc);
      const mergedBytes: Uint8Array = await mergedDoc.save({
        useObjectStreams: false,
      });
      return Buffer.from(mergedBytes);
    } catch (error) {
      throw new InternalServerErrorException(
        `Error anexando la hoja de firmas al documento: ${error}`,
      );
    }
  }

  /** Estampa "CANCELADO" en diagonal rojo semitransparente en todas las páginas del PDF. */
  async stampCancelledWatermark(documentBuffer: Buffer): Promise<Buffer> {
    return this.stampDiagonalWatermark(
      documentBuffer,
      'CANCELADO',
      rgb(0.75, 0, 0),
    );
  }

  /**
   * Historia "Eliminar nombre al estampar firma simple": acá vivía `addSignerName`, que dibujaba
   * el nombre del firmante como texto 20pt debajo de cada firma estampada. Se eliminó junto con
   * su único llamador (`DocumentService.finalizeSignedDocument`): el estampado ahora es solo la
   * imagen de la firma. El nombre del firmante sigue registrado en la hoja de firmas del resumen
   * (`SummaryDocumentService`), que es donde corresponde la evidencia en texto.
   */

  /** Estampa "RECHAZADO" en diagonal naranja semitransparente en todas las páginas del PDF. */
  async stampRejectedWatermark(documentBuffer: Buffer): Promise<Buffer> {
    return this.stampDiagonalWatermark(
      documentBuffer,
      'RECHAZADO',
      rgb(0.85, 0.35, 0),
    );
  }

  /**
   * Estampa texto diagonal centrado en cada página del PDF, escalado para cruzar de esquina a esquina.
   * Aplica conformidad PDF/A-2B al resultado.
   */
  private async stampDiagonalWatermark(
    documentBuffer: Buffer,
    text: string,
    color: ReturnType<typeof rgb>,
  ): Promise<Buffer> {
    const pdfDoc = await PDFDocument.load(documentBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    for (const page of pdfDoc.getPages()) {
      const { width, height } = page.getSize();
      const diagonalLength = Math.sqrt(width * width + height * height);
      const angleRad = Math.atan2(height, width);
      const angleDeg = (angleRad * 180) / Math.PI;

      const textWidthAt1 = font.widthOfTextAtSize(text, 1);
      const fontSize = (diagonalLength * 0.75) / textWidthAt1;
      const textWidth = font.widthOfTextAtSize(text, fontSize);

      // Centrar el texto rotado en el centro geométrico de la página
      const cx =
        width / 2 -
        (textWidth / 2) * Math.cos(angleRad) +
        (fontSize / 2) * Math.sin(angleRad);
      const cy =
        height / 2 -
        (textWidth / 2) * Math.sin(angleRad) -
        (fontSize / 2) * Math.cos(angleRad);

      page.drawText(text, {
        x: cx,
        y: cy,
        size: fontSize,
        font,
        color,
        opacity: 0.35,
        rotate: degrees(angleDeg),
      });
    }

    this.applyPdfA2bConformance(pdfDoc);
    const bytes = await pdfDoc.save({ useObjectStreams: false });
    return Buffer.from(bytes);
  }

  /**
   * Pinta el borde blanco alrededor del código y avisa si quedó demasiado chico para leerse.
   *
   * El rectángulo se dibuja por fuera del código (puede sobresalir unos puntos de la caja de
   * firma): es lo que garantiza la zona de silencio sin recortarle tamaño a los módulos.
   */
  private drawQuietZone(
    page: PDFPage,
    placement: { x: number; y: number; width: number; height: number },
  ): void {
    page.drawRectangle({
      x: placement.x - QR_QUIET_ZONE_PT,
      y: placement.y - QR_QUIET_ZONE_PT,
      width: placement.width + QR_QUIET_ZONE_PT * 2,
      height: placement.height + QR_QUIET_ZONE_PT * 2,
      color: rgb(1, 1, 1),
    });

    if (placement.width < QR_MIN_SCANNABLE_SIDE_PT) {
      this.logger.warn(
        `El código QR se estampó a ${placement.width.toFixed(1)}pt de lado, por debajo del mínimo ` +
          `escaneable (${QR_MIN_SCANNABLE_SIDE_PT}pt): la caja de firma asignada es demasiado ` +
          'chica y es probable que ningún lector consiga leerlo.',
      );
    }
  }

  /**
   * Encaja la imagen dentro de la caja resuelta SIN deformarla, centrada en ella.
   *
   * La caja de firma es un rectángulo apaisado (200x80 por defecto), pensado para una rúbrica
   * manuscrita: estirar ahí una imagen cuadrada la deja el doble de ancha que de alta. Para una
   * rúbrica eso es un detalle estético, pero el código QR de una firma avanzada deja de ser
   * cuadrado y los lectores dejan de reconocer su patrón — por eso se escala al lado menor de la
   * caja y se centra, en vez de rellenarla.
   */
  private fitPreservingAspectRatio(
    image: PDFImage,
    coordinates: SignatureCoordinates,
    boxSize: { width: number; height: number },
  ): { x: number; y: number; width: number; height: number } {
    const scale = Math.min(
      boxSize.width / image.width,
      boxSize.height / image.height,
    );
    const width = image.width * scale;
    const height = image.height * scale;

    return {
      x: coordinates.x + (boxSize.width - width) / 2,
      y: coordinates.y + (boxSize.height - height) / 2,
      width,
      height,
    };
  }

  /**
   * Devuelve el tamaño final con el que se dibujará la firma.
   * Si width o height están fuera del rango [MIN, MAX] se usa DEFAULT_SIGNATURE_SIZE.
   */
  private resolveSignatureSize(
    coordinates: SignatureCoordinates,
    minSize = MIN_SIGNATURE_SIZE,
    maxSize = MAX_SIGNATURE_SIZE,
    defaultSize = DEFAULT_SIGNATURE_SIZE,
  ): { width: number; height: number } {
    const { width, height } = coordinates;

    const tooSmall = width < minSize.width || height < minSize.height;
    const tooBig = width > maxSize.width || height > maxSize.height;

    if (tooSmall || tooBig) {
      return { ...defaultSize };
    }

    return { width, height };
  }

  async getPdfPages(file: Express.Multer.File) {
    try {
      const buffer = file.buffer;
      const pdf = await PDFDocument.load(buffer);
      const totalPages = pdf.getPageCount();
      return totalPages;
    } catch (error) {
      throw new InternalServerErrorException(
        `Error obteniendo la cantidad total de imagenes del pdf: ${error}`,
      );
    }
  }
}

// EJEMPLO DE USO
//
// 1. Importar DocumentSigningModule en el módulo que lo necesite:
//
//    import { DocumentSigningModule } from 'src/shared/document-signing/document-signing.module';
//
//    @Module({
//      imports: [DocumentSigningModule],
//    })
//    export class DocumentModule {}
//
// 2. Inyectar PdfSignatureService en el servicio o controlador destino:
//
//    import { PdfSignatureService } from 'src/shared/document-signing/document-signing.service';
//    import { SignatureCoordinates } from 'src/shared/document-signing/interfaces/signature-coordinates.interface';
//
//    @Injectable()
//    export class DocumentService {
//      constructor(private readonly pdfSignatureService: PdfSignatureService) {}
//
//      async signDocument(documentBuffer: Buffer, signatureBuffer: Buffer): Promise<Buffer> {
//        const coordinates: SignatureCoordinates = {
//          x: 60,       // distancia desde el borde izquierdo (puntos PDF)
//          y: 40,       // distancia desde el borde inferior  (puntos PDF)
//          width: 200,  // si queda fuera de [60–320], se aplica el DEFAULT (200x80)
//          height: 80,
//          opacity: 0.9, // opcional: 0.0 invisible, 1.0 completamente opaco (default)
//        };
//
//        const signedPdf: Buffer = await this.pdfSignatureService.mergeSignatureIntoPdf(
//          documentBuffer,
//          signatureBuffer,
//          coordinates,
//        );
//
//        return signedPdf;
//      }
//    }
//
// UMBRALES DE TAMAÑO (puntos PDF):
//   Demasiado chica  → width < 60  o height < 24
//   Demasiado grande → width > 320 o height > 128
//   Tamaño default   → 200 x 80
//   Para cambiar estos valores, editar las constantes al inicio del archivo:
//     DEFAULT_SIGNATURE_SIZE, MIN_SIGNATURE_SIZE, MAX_SIGNATURE_SIZE
//
// PERFIL ICC sRGB (requerido para conformidad PDF/A-2B completa):
//   Descargar de: https://www.color.org/srgbprofiles.xalter
//   Guardar como: src/shared/document-signing/resources/sRGB.icc
//   El build de NestJS copia automáticamente *.icc a dist/ (configurado en nest-cli.json).
//   Sin el perfil ICC, el documento tendrá metadatos XMP PDF/A-2B pero le faltará el
//   OutputIntent, por lo que no pasará un validador estricto de PDF/A-2B.
