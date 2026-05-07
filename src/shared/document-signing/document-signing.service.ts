import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PDFDocument, PDFImage, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import * as fs from 'fs';
import * as path from 'path';
import { SignatureCoordinates } from './interfaces/signature-coordinates.interface';
import { DEFAULT_COORDINATES } from './interfaces/default-signing-coordinates.interface';


// Posición por defecto: esquina inferior derecha de una página A4 (595 x 842 pt)


// Para ajustar los limites solo hayq ue modificar las tres constantes siguientes. Si la firma queda fuera de estos rangos, se normaliza a DEFAULT_SIGNATURE_SIZE.
// Tamaño al que se normaliza la firma cuando está fuera de rango (puntos PDF)
const DEFAULT_SIGNATURE_SIZE = { width: 200, height: 80 };

// Umbral mínimo: firmas más pequeñas que esto se consideran demasiado chicas
const MIN_SIGNATURE_SIZE = { width: 60, height: 24 };

// Umbral máximo: firmas más grandes que esto se consideran demasiado grandes
const MAX_SIGNATURE_SIZE = { width: 320, height: 128 };

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
   * @returns               PDF firmado en formato PDF/A-2B como Buffer.
   */
  async mergeSignatureIntoPdf(
    documentBuffer: Buffer,
    signatureBuffer: Buffer,
    coordinates: SignatureCoordinates = DEFAULT_COORDINATES,
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
      throw new BadRequestException('FORMATO DE IMAGEN NO SOPORTADO. SOLO SE PERMITEN PNG');
    }

    // Paso 4: seleccionar la última página del documento como destino de la firma
    const pages = pdfDoc.getPages();
    const lastPage = pages[pages.length - 1];

    // Paso 5: resolver el tamaño final de la firma aplicando el resize automático si corresponde
    const drawSize = this.resolveSignatureSize(coordinates);

    // Paso 6: dibujar la firma en la página con las coordenadas, dimensiones y opacidad resueltas
    lastPage.drawImage(signatureImage, {
      x: coordinates.x,
      y: coordinates.y,
      width: drawSize.width,
      height: drawSize.height,
      opacity: coordinates.opacity ?? 1.0,
    });

    // Paso 7: aplicar conformidad PDF/A-2B (XMP metadata + OutputIntent sRGB)
    this.applyPdfA2bConformance(pdfDoc);

    // Paso 8: serializar sin object streams para máxima compatibilidad con validadores PDF/A
    const signedPdfBytes: Uint8Array = await pdfDoc.save({ useObjectStreams: false });
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
    pdfDoc.catalog.set(PDFName.of('Metadata'), pdfDoc.context.register(metadataStream));

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
    const tooBig   = width > maxSize.width  || height > maxSize.height;

    if (tooSmall || tooBig) {
      return { ...defaultSize };
    }

    return { width, height };
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
