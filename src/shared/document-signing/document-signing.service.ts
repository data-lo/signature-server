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
import {
  displayedPageSize,
  normalizePageRotation,
  pageOrientation,
  toContentSpace,
  toVisibleRect,
} from './page-geometry';

// Posición por defecto: esquina inferior derecha de una página A4 (595 x 842 pt)

// Tamaño al que se normaliza la firma que cae fuera del rango [MIN, MAX] (puntos PDF).
const DEFAULT_SIGNATURE_SIZE = { width: 200, height: 80 };

const MIN_SIGNATURE_SIZE = { width: 60, height: 24 };

const MAX_SIGNATURE_SIZE = { width: 320, height: 128 };

/**
 * Borde blanco alrededor de un QR estampado ("zona de silencio"): la norma QR exige un margen libre
 * y, medido, con el texto del documento pegado a 0pt el código no se decodifica a 150 DPI, mientras
 * que con 2pt de separación sí.
 *
 * El PNG se genera sin margen propio para que sus módulos queden lo más grandes posible, así que el
 * margen se pinta acá, POR FUERA del código y no a costa de su tamaño.
 */

/**
 * Lado mínimo, en puntos, para que un QR estampado siga siendo escaneable.
 *
 * Medido con un decodificador real sobre la página rasterizada: a 80pt el código se lee a 150 y 300
 * DPI, y a 24pt —el mínimo que admite una caja de firma— no se lee a ninguna resolución, porque sus
 * módulos quedan en ~0.12mm. Por debajo del umbral se advierte, en vez de estampar en silencio un
 * código que nadie va a poder leer.
 */

// Rutas del perfil ICC sRGB, probadas en orden. Sin el perfil el PDF conserva los metadatos XMP
// PDF/A-2B pero le falta el OutputIntent, así que no pasa un validador estricto: se descarga de
// https://www.color.org/srgbprofiles.xalter y el build copia `*.icc` a `dist/` (ver nest-cli.json).
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
      // Prueba la siguiente ruta.
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
   * Incrusta la imagen de firma en el PDF en las coordenadas indicadas y serializa el resultado como
   * PDF/A-2B (ISO 19005-2, nivel B), que admite transparencias y por eso acepta firmas PNG con canal
   * alfa.
   *
   * @param pageIndex Página destino, 0-based. Por defecto la última, el mismo comportamiento previo
   *                  al soporte multipágina.
   * @param options   `preserveAspectRatio` encaja la imagen dentro de la caja sin deformarla,
   *                  centrada: lo usa el QR de la firma avanzada, mientras que las rúbricas siguen
   *                  ocupando la caja completa.
   *
   *                  `normalizeSize: false` respeta el tamaño recibido y se salta el resize
   *                  automático. Lo pasa el estampado por posición configurada, donde el tamaño es el
   *                  de la caja que el usuario dibujó sobre la página y sustituirlo por el tamaño por
   *                  defecto movería la firma del lugar donde se la ve colocada.
   */
  async mergeSignatureIntoPdf(
    documentBuffer: Buffer,
    signatureBuffer: Buffer,
    coordinates: SignatureCoordinates,
    pageIndex?: number,
    options?: { preserveAspectRatio?: boolean; normalizeSize?: boolean },
  ): Promise<Buffer> {
    const pdfDoc: PDFDocument = await PDFDocument.load(documentBuffer);

    let signatureImage: PDFImage;
    const signatureBytes: Uint8Array = new Uint8Array(signatureBuffer);

    // Firma de bytes que identifica un PNG: 89 50 4E 47.
    const isPng: boolean =
      signatureBytes[0] === 0x89 &&
      signatureBytes[1] === 0x50 &&
      signatureBytes[2] === 0x4e &&
      signatureBytes[3] === 0x47;

    if (isPng) {
      signatureImage = await pdfDoc.embedPng(signatureBuffer);
    } else {
      throw new BadRequestException(
        'FORMATO DE IMAGEN NO SOPORTADO. SOLO SE PERMITEN PNG',
      );
    }

    const pages = pdfDoc.getPages();
    const targetPage =
      pages[pageIndex ?? pages.length - 1] ?? pages[pages.length - 1];

    /**
     * Resuelve el tamaño en el espacio VISIBLE, que es donde el usuario colocó la caja: en una hoja
     * con `/Rotate` los lados del MediaBox están intercambiados, y medir ahí compararía el ancho de
     * la rúbrica contra el alto de la página.
     *
     * El resize automático corrige los tamaños que llegan sin respaldo —coordenadas legacy en
     * píxeles, apilado por defecto—. Una caja configurada por el usuario no es ese caso: su tamaño se
     * derivó de las dimensiones de la página y normalizarla a `DEFAULT_SIGNATURE_SIZE` la movería a
     * un tamaño que nadie eligió, justo lo que ocurre en una hoja muy ancha donde el ancho supera el
     * máximo sin que nada esté mal.
     */
    const drawSize =
      options?.normalizeSize === false
        ? { width: coordinates.width, height: coordinates.height }
        : this.resolveSignatureSize(coordinates);

    // Encaja la imagen también en espacio visible: `preserveAspectRatio` centra el QR dentro de la
    // caja, y "centrado" sólo significa algo respecto de los ejes que ve el usuario.
    const visiblePlacement = options?.preserveAspectRatio
      ? this.fitPreservingAspectRatio(signatureImage, coordinates, drawSize)
      : { x: coordinates.x, y: coordinates.y, ...drawSize };

    /**
     * Traduce del espacio VISIBLE al espacio del CONTENIDO, el único que entiende `drawImage` (ver
     * `page-geometry.ts`).
     *
     * Lee la rotación de la página destino en vez de recibirla: `/Rotate` es un dato del archivo, no
     * de quien pide el estampado, y resolverlo acá corrige a la vez todos los caminos —ratios,
     * coordenadas legacy y apilado automático— sin que ninguno tenga que acordarse de un parámetro.
     *
     * En una página sin `/Rotate` la conversión es la identidad y `rotate` vale 0: el comportamiento
     * anterior se conserva byte por byte.
     */
    const rotation = normalizePageRotation(targetPage.getRotation().angle);
    const placement = toContentSpace(
      { ...visiblePlacement, opacity: coordinates.opacity },
      targetPage.getSize(),
      rotation,
    );

    targetPage.drawImage(signatureImage, {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      rotate: degrees(placement.rotate),
      opacity: coordinates.opacity ?? 1.0,
    });

    this.applyPdfA2bConformance(pdfDoc);

    // Sin object streams: máxima compatibilidad con validadores PDF/A.
    const signedPdfBytes: Uint8Array = await pdfDoc.save({
      useObjectStreams: false,
    });
    return Buffer.from(signedPdfBytes);
  }

  /**
   * Agrega los marcadores mínimos que exige PDF/A-2B: metadatos XMP en el catálogo (pdfaid:part=2,
   * pdfaid:conformance=B) y un OutputIntent con perfil ICC sRGB.
   *
   * Si el perfil ICC no aparece, advierte y omite el OutputIntent: el documento conserva los
   * metadatos XMP correctos pero no queda completamente conforme.
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
   * Convierte una posición en ratios 0-1 a coordenadas absolutas en puntos contra el tamaño real de
   * la página destino: los ratios no significan nada sin el tamaño de ESA página, que puede variar
   * entre páginas del mismo documento.
   *
   * **Mide contra la página COMO SE VE, no contra su MediaBox.** El frontend mide el drop sobre la
   * hoja que dibuja pdf.js, que ya aplicó el `/Rotate`: una hoja apaisada escrita como "vertical +
   * `/Rotate 90`" —lo que exportan Word y los escáneres— tiene un MediaBox de 595x842 y se ve de
   * 842x595. Medir contra el MediaBox sacaba la firma de lugar y de costado en las hojas
   * horizontales; `displayedPageSize` resuelve cuál de los dos tamaños corresponde.
   *
   * Devuelve en ese mismo espacio visible: `mergeSignatureIntoPdf` traduce al espacio del contenido
   * justo antes de dibujar.
   *
   * `yRatio` se mide desde el borde SUPERIOR, igual que el frontend mide la posición del drop en el
   * DOM, de ahí la resta contra el alto.
   *
   * `page` es 1-based; fuera de rango cae en la última página en vez de lanzar.
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
    const pageIndex = Math.min(
      Math.max(position.page - 1, 0),
      pages.length - 1,
    );
    const targetPage = pages[pageIndex];
    const content = targetPage.getSize();
    const rotation = normalizePageRotation(targetPage.getRotation().angle);

    const displayed = displayedPageSize(content, rotation);
    const orientation = pageOrientation(content, rotation);

    // Registra sólo geometría, ningún dato del firmante: es lo primero que hace falta cuando alguien
    // reporta una firma fuera de lugar, y no se deduce del PDF sin volver a abrirlo.
    this.logger.debug(
      `Página ${position.page}: MediaBox ${content.width}x${content.height}, /Rotate ${rotation}, ` +
        `se ve ${displayed.width}x${displayed.height} (${orientation}).`,
    );

    return { pageIndex, coordinates: toVisibleRect(position, displayed) };
  }

  /**
   * Devuelve un PDF nuevo con las páginas de `documentBuffer` seguidas de las de `pagesBuffer`.
   *
   * No modifica ninguno de los dos: `copyPages` serializa las páginas del origen dentro de un
   * documento recién creado, así que el documento firmado y la hoja quedan intactos en sus buckets.
   * Tampoco re-estampa ni recalcula nada: las firmas ya dibujadas viajan tal cual dentro de las
   * páginas copiadas.
   *
   * Serializa con la misma conformidad PDF/A-2B que el resto del servicio: la versión definitiva que
   * ve el usuario no puede ser menos archivable que la que la originó.
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

  /** Estampa "RECHAZADO" en diagonal naranja semitransparente en todas las páginas del PDF. */
  async stampRejectedWatermark(documentBuffer: Buffer): Promise<Buffer> {
    return this.stampDiagonalWatermark(
      documentBuffer,
      'RECHAZADO',
      rgb(0.85, 0.35, 0),
    );
  }

  /** Estampa texto diagonal centrado, escalado para cruzar de esquina a esquina, con PDF/A-2B. */
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

      // Centra el texto rotado en el centro geométrico de la página.
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
   * Encaja la imagen dentro de la caja SIN deformarla, centrada en ella.
   *
   * La caja es un rectángulo apaisado (200x80 por defecto) pensado para una rúbrica manuscrita:
   * estirar ahí una imagen cuadrada la deja el doble de ancha que de alta. En una rúbrica eso es
   * estético, pero un QR deforme pierde su patrón y los lectores dejan de reconocerlo, así que se
   * escala al lado menor de la caja y se centra en vez de rellenarla.
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

  /** Normaliza a `DEFAULT_SIGNATURE_SIZE` el tamaño que caiga fuera del rango [min, max]. */
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
