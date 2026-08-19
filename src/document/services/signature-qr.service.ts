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

/** Datos de la firma que se codifican en el QR. Todos salen del colaborador que firmó, no de su perfil en vivo. */
export interface AdvancedSignatureQrData {
  /** Nombre completo del firmante; preferentemente el del certificado del SAT. */
  signerName: string;
  rfc?: string | null;
  ipAddress?: string | null;
  geoLocation?: { latitude: number; longitude: number } | null;
  /** Momento real de la firma (`advancedSignature.signedAt`, con el del colaborador como respaldo). */
  signedAt?: Date | string | null;
  /** Constancia pública de esta firma — se conserva como última línea para que el QR siga llevando a la verificación en línea. */
  verificationUrl: string;
}

/** Etiqueta que encabeza el contenido, para que quien escanee sepa de inmediato qué está leyendo. */
const QR_TITLE = 'Firma Electrónica Avanzada — Firmalo';

/** Sin dato es preferible a un renglón mentiroso: los campos vacíos se omiten del contenido. */
const EMPTY_FIELD_PLACEHOLDER = 'No disponible';

/**
 * Genera el código QR que representa visualmente a una firma avanzada (historias "Generar código
 * QR para firmas avanzadas" y "Actualizar contenido del código QR en firma avanzada").
 *
 * Existe porque la firma avanzada (e.firma) no produce ninguna imagen: su evidencia es
 * criptográfica y hasta ahora no se dibujaba nada en el documento, así que el lugar reservado
 * para esa firma quedaba vacío. El QR ocupa ese lugar y cumple la misma función que la rúbrica de
 * una firma simple: dejar constancia visible de quién firmó.
 *
 * El contenido es TEXTO PLANO con los datos del firmante y del evento de firma, no solo un enlace:
 * quien escanea el código con cualquier lector ve ahí mismo quién firmó, cuándo, desde dónde y con
 * qué RFC, sin depender de tener red ni de que la plataforma siga en línea. La URL de la
 * constancia va como última línea para no perder la verificación en línea que ya existía.
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
   * Texto que lee el escáner. Un renglón por dato, con etiqueta al frente: es el formato que
   * cualquier lector muestra tal cual, sin necesitar una app que sepa interpretarlo.
   */
  buildContent(data: AdvancedSignatureQrData): string {
    return [
      QR_TITLE,
      `Firmante: ${data.signerName || EMPTY_FIELD_PLACEHOLDER}`,
      `RFC: ${data.rfc || EMPTY_FIELD_PLACEHOLDER}`,
      `Fecha y hora: ${this.formatSignedAt(data.signedAt)}`,
      `IP: ${data.ipAddress || EMPTY_FIELD_PLACEHOLDER}`,
      `Geolocalización: ${this.formatGeoLocation(data.geoLocation)}`,
      `Constancia: ${data.verificationUrl}`,
    ].join('\n');
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

  /**
   * Fecha y hora en la zona horaria del sistema, con el desfase explícito (`GMT-6`).
   *
   * El desfase no es decorativo: el QR queda impreso en un documento que se puede leer en
   * cualquier lugar y años después, y una hora sin zona no identifica un instante. Se usa la del
   * servidor (`TZ`, o la que resuelva el sistema operativo) porque es la única definida en el
   * momento de firmar — quien escanea puede estar en otro huso, y la constancia no debería cambiar
   * según quién la mire.
   */
  private formatSignedAt(value: Date | string | null | undefined): string {
    if (!value) {
      return EMPTY_FIELD_PLACEHOLDER;
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return EMPTY_FIELD_PLACEHOLDER;
    }

    return new Intl.DateTimeFormat('es-MX', {
      timeZone: resolveSystemTimeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    }).format(date);
  }

  /** Seis decimales: ~11 cm de precisión, más que suficiente para lo que reporta un navegador. */
  private formatGeoLocation(
    geoLocation: { latitude: number; longitude: number } | null | undefined,
  ): string {
    if (!geoLocation) {
      return EMPTY_FIELD_PLACEHOLDER;
    }

    return `${geoLocation.latitude.toFixed(6)}, ${geoLocation.longitude.toFixed(6)}`;
  }
}

/**
 * Zona horaria del sistema. `TZ` gana cuando está configurada (es como se fija la zona de un
 * contenedor); si trae un valor que Intl no reconoce, se cae a la que resuelva el runtime en vez
 * de reventar la generación del QR —y con ella el estampado de todo el documento— por una variable
 * de entorno mal escrita.
 */
function resolveSystemTimeZone(): string {
  const configured = process.env.TZ;

  if (configured) {
    try {
      new Intl.DateTimeFormat('es-MX', { timeZone: configured });
      return configured;
    } catch {
      // Cae al valor resuelto por el runtime.
    }
  }

  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
