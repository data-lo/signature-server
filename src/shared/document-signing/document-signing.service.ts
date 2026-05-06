// NestJS (framework)
import { BadRequestException, Injectable } from '@nestjs/common';

// Third party
import { PDFDocument, PDFImage } from 'pdf-lib';

import { SignatureCoordinates } from 'src/document/interfaces/signature-coordinates';


// Posición por defecto: esquina inferior derecha de una página A4 (595 x 842 pt)
const DEFAULT_COORDINATES: SignatureCoordinates = {
  x:   0,
  y:  0,
  width: 0,
  height: 0
};

@Injectable()
export class DocumentSigningService {
  /**
   * Incrusta la imagen de firma en el documento PDF en las coordenadas indicadas.
   * 
   *  1. Carga el PDF original desde el Buffer recibido para poder modificarlo en memoria.
   * 
   *  2. Detecta el formato de la imagen (PNG o JPG) leyendo los primeros 4 bytes del Buffer,
   *     ya que pdf-lib requiere llamar a métodos distintos según el formato.
   * 
   *  3. Incrusta la imagen en el documento PDF, lo que la registra como recurso interno
   *     del PDF antes de poder dibujarla en alguna página.
   * 
   *  4. Selecciona la última página del documento como destino de la firma.
   * 
   *  5. Dibuja la imagen de firma en las coordenadas (x, y) con el tamaño (width, height)
   *     indicados. El origen (0,0) en PDF está en la esquina inferior izquierda.
   * 
   *  6. Serializa el documento modificado a bytes y lo retorna como Buffer.
   *
   * @param documentBuffer  PDF original como Buffer de bytes.
   * @param signatureBuffer Imagen de la firma (PNG o JPG) como Buffer de bytes.
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

    // Paso 5: dibujar la firma en la página con las coordenadas y dimensiones recibidas
    lastPage.drawImage(signatureImage, {
      x: coordinates.x,
      y: coordinates.y,
      width: coordinates.width,
      height: coordinates.height,
    });

    // Paso 6: serializar el documento modificado y retornarlo como Buffer
    const signedPdfBytes: Uint8Array = await pdfDoc.save();
    return Buffer.from(signedPdfBytes);
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
//          width: 200,
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
