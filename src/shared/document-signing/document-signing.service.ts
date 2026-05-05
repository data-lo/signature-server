import { BadRequestException, Injectable } from '@nestjs/common';
import { PDFDocument, PDFImage } from 'pdf-lib';
import { SignatureCoordinates } from './interfaces/signature-coordinates.interface';

const DEFAULT_COORDINATES: SignatureCoordinates = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};

// Para ajustar los limites solo hayq ue modificar las tres constantes siguientes. Si la firma queda fuera de estos rangos, se normaliza a DEFAULT_SIGNATURE_SIZE.
// Tamaño al que se normaliza la firma cuando está fuera de rango (puntos PDF)
const DEFAULT_SIGNATURE_SIZE = { width: 200, height: 80 };

// Umbral mínimo: firmas más pequeñas que esto se consideran demasiado chicas
const MIN_SIGNATURE_SIZE = { width: 60, height: 24 };

// Umbral máximo: firmas más grandes que esto se consideran demasiado grandes
const MAX_SIGNATURE_SIZE = { width: 320, height: 128 };

@Injectable()
export class PdfSignatureService {
  /**
   * Incrusta la imagen de firma en el documento PDF en las coordenadas indicadas.
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
   *
   *  7. Serializa el documento modificado a bytes y lo retorna como Buffer.
   *
   * @param documentBuffer  PDF original como Buffer de bytes.
   * @param signatureBuffer Imagen de la firma (PNG) como Buffer de bytes.
   * @param coordinates     Posición y tamaño donde incrustar la firma en la página.
   * @returns               PDF firmado como Buffer.
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

    // Paso 6: dibujar la firma en la página con las coordenadas y dimensiones resueltas
    lastPage.drawImage(signatureImage, {
      x: coordinates.x,
      y: coordinates.y,
      width: drawSize.width,
      height: drawSize.height,
    });

    // Paso 7: serializar el documento modificado y retornarlo como Buffer
    const signedPdfBytes: Uint8Array = await pdfDoc.save();
    return Buffer.from(signedPdfBytes);
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
//          x: 60,    // distancia desde el borde izquierdo (puntos PDF)
//          y: 40,    // distancia desde el borde inferior  (puntos PDF)
//          width: 200,  // si queda fuera de [60–320], se aplica el DEFAULT (200x80)
//          height: 80,
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
