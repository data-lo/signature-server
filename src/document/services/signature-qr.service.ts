import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';

/**
 * Tamaño del PNG generado, en píxeles. No define el tamaño con el que se ve en el documento —eso
 * lo decide la posición asignada al firmante, igual que con una rúbrica— sino la resolución del
 * origen: el QR se estampa reescalado, y un PNG chico se vería pixelado al imprimir el PDF.
 */
const QR_PIXEL_SIZE = 512;

/**
 * Sin margen (`margin: 0`) porque el espacio en blanco alrededor ya lo aporta la caja de firma
 * donde se estampa; con el margen por defecto de la librería el código quedaría notoriamente más
 * chico dentro de su recuadro y más difícil de escanear.
 */
const QR_MARGIN = 0;

/**
 * Genera el código QR que representa visualmente a una firma avanzada (historia "Generar código
 * QR para firmas avanzadas").
 *
 * Existe porque la firma avanzada (e.firma) no produce ninguna imagen: su evidencia es
 * criptográfica y hasta ahora no se dibujaba nada en el documento, así que el lugar reservado
 * para esa firma quedaba vacío. El QR ocupa ese lugar y cumple la misma función que la rúbrica de
 * una firma simple —dejar constancia visible de quién firmó— con la ventaja de que además lleva a
 * la información completa de la firma.
 *
 * Devuelve un PNG para que el estampado sea exactamente el mismo camino que el de una rúbrica
 * (`DocumentSigningService.mergeSignatureIntoPdf`): el QR no necesita un mecanismo de posicionado
 * propio, usa el que ya coloca las firmas en sus coordenadas.
 */
@Injectable()
export class SignatureQrService {
  /**
   * PNG del código QR que apunta a `url`. Con corrección de errores media (M): el código se
   * imprime y puede fotocopiarse o escanearse en papel, donde parte del patrón se degrada.
   */
  async generatePngBuffer(url: string): Promise<Buffer> {
    return QRCode.toBuffer(url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      width: QR_PIXEL_SIZE,
      margin: QR_MARGIN,
    });
  }
}
