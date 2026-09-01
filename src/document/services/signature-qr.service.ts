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
 * Lo que se codifica en el QR: nada más que el enlace.
 *
 * Aquí viajaban además el nombre, el RFC, la IP y la fecha de la firma, que se imprimían como
 * texto dentro del código. Ese contenido quedaba legible para cualquiera que escaneara la hoja
 * —incluida una copia impresa que circulara fuera de la plataforma— sin pasar por ningún control
 * sobre qué se publica de un firmante. Ahora esos datos sólo se ven en la vista pública, que es
 * la que decide qué expone y bajo qué condiciones.
 */
export interface AdvancedSignatureQrData {
  /** Vista pública del documento, con esta firma señalada (ver `buildAdvancedSignatureUrl`). */
  verificationUrl: string;
}

/**
 * Genera el código QR que representa visualmente a una firma avanzada (historias "Generar código
 * QR para firmas avanzadas" y "Actualizar contenido del código QR en firma avanzada").
 *
 * Existe porque la firma avanzada (e.firma) no produce ninguna imagen: su evidencia es
 * criptográfica y hasta ahora no se dibujaba nada en el documento, así que el lugar reservado
 * para esa firma quedaba vacío. El QR ocupa ese lugar y cumple la misma función que la rúbrica de
 * una firma simple: dejar constancia visible de quién firmó.
 *
 * **El contenido es ÚNICAMENTE la URL de la vista pública del documento, con esta firma
 * señalada.** Antes era texto plano con el nombre, el RFC, la IP y la fecha, y el enlace como
 * última línea. Eso tenía dos problemas: publicaba datos del firmante a cualquiera que escaneara
 * una copia impresa, sin pasar por ningún control sobre qué se expone; y un QR de varias líneas
 * de texto no es un enlace para el lector del teléfono, que muestra el texto en vez de abrir la
 * verificación. Con la URL sola, escanear el código abre el documento.
 *
 * Se pierde a cambio la lectura sin red que aquel formato permitía. Es la decisión de la historia
 * "Redirigir QR de firma avanzada a la vista pública": la constancia legible sin conexión ya vive
 * en la hoja de firmas anexada al PDF, que imprime nombre, certificado y fecha de cada firmante.
 *
 * Los QR ya estampados conservan el contenido con el que se generaron —son parte del PDF y no se
 * regeneran—, así que la pantalla a la que apuntaban sigue existiendo.
 *
 * Devuelve un PNG para que el estampado sea exactamente el mismo camino que el de una rúbrica
 * (`DocumentSigningService.mergeSignatureIntoPdf`): el QR no necesita un mecanismo de posicionado
 * propio, usa el que ya coloca las firmas en sus coordenadas.
 */
@Injectable()
export class SignatureQrService {
  /** PNG del código QR con los datos de una firma avanzada ya completada. */
  async generateAdvancedSignaturePng(
    data: AdvancedSignatureQrData,
  ): Promise<Buffer> {
    return this.generatePngBuffer(this.buildContent(data));
  }

  /**
   * Lo que lee el escáner: la URL a secas.
   *
   * Sin etiquetas ni renglones adicionales a propósito. Un QR cuyo contenido es exactamente una
   * URL lo reconocen como enlace la cámara nativa y el lector del teléfono, y ofrecen abrirlo; en
   * cuanto se le antepone una línea de texto pasa a ser un QR de texto y deja de ser accionable.
   */
  buildContent(data: AdvancedSignatureQrData): string {
    return data.verificationUrl;
  }

  /**
   * PNG del código QR con el contenido dado. Con corrección de errores media (M): el código se
   * imprime y puede fotocopiarse o escanearse en papel, donde parte del patrón se degrada.
   */
  async generatePngBuffer(content: string): Promise<Buffer> {
    return QRCode.toBuffer(content, {
      type: 'png',
      errorCorrectionLevel: 'M',
      width: QR_PIXEL_SIZE,
      margin: QR_MARGIN,
    });
  }
}
