import jsQR from 'jsqr';
import * as sharp from 'sharp';
import {
  SignatureQrService,
  type AdvancedSignatureQrData,
} from './signature-qr.service';

/**
 * Decodifica el PNG como lo haría un lector de códigos: lo convierte a píxeles crudos RGBA y lo
 * lee con un decodificador real. Es la única forma de comprobar de verdad el criterio "al
 * escanearlo, muestra correctamente nombre, RFC, IP y fecha/hora" — que el código no solo sea un
 * PNG válido, sino que un escáner obtenga de él exactamente ese contenido.
 */
async function decodeQr(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return decoded?.data ?? null;
}

/**
 * URL de la constancia pública de la firma, con la forma que produce `buildAdvancedSignatureUrl`.
 *
 * Bug corregido: la constante se usaba en tres lugares del archivo pero su declaración se perdió
 * en el merge `39fe940`, así que esta suite no compilaba —ni una sola de sus pruebas corría— desde
 * entonces. Se restituye aquí porque sin ella no hay forma de ejecutar la comprobación de que el
 * QR ya no publica la geolocalización.
 */
const VERIFICATION_URL =
  'http://localhost:3001/public/documents/doc-1/signatures/collab-1';

/** Firma de un PNG: los 8 bytes iniciales que todo archivo PNG válido debe tener. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Generar y decodificar códigos QR de 512px es trabajo de CPU real: sueltas estas pruebas tardan
 * ~3s, pero corriendo la suite completa en paralelo llegan a pasarse de los 5s por defecto de jest
 * y fallaban por timeout de forma intermitente. El límite se sube acá en vez de bajar la
 * resolución del QR, que es lo que hace que la comprobación con un decodificador real valga.
 */
jest.setTimeout(30_000);

describe('SignatureQrService', () => {
  const service = new SignatureQrService();

  const signature: AdvancedSignatureQrData = {
    signerName: 'JUAN ANGEL CEPEDA FERNANDEZ',
    rfc: 'CEFJ800101ABC',
    ipAddress: '189.237.82.225',
    signedAt: new Date('2026-07-30T15:59:22Z'),
    verificationUrl: VERIFICATION_URL,
  };

  describe('contenido del código', () => {
    it('lleva el nombre, el RFC, la IP y la fecha de la firma', () => {
      const content = service.buildContent(signature);

      expect(content).toContain('Firmante: JUAN ANGEL CEPEDA FERNANDEZ');
      expect(content).toContain('RFC: CEFJ800101ABC');
      expect(content).toContain('IP: 189.237.82.225');
      expect(content).toContain('Fecha y hora: ');
    });

    /**
     * Historia "Ocultar geolocalización en hojas de firma y vistas públicas": el QR queda
     * impreso en el documento y es de los pocos lugares donde el dato se publicaba sin que
     * nadie lo pidiera. Se afirma la AUSENCIA porque volver a agregarlo es un renglón, y este
     * texto no lo revisa nadie una vez estampado.
     */
    it('no publica la geolocalización, aunque la firma la tenga registrada', () => {
      const content = service.buildContent(signature);

      expect(content).not.toMatch(/geolocaliza/i);
      expect(content).not.toContain('19.4326');
      expect(content).not.toContain('-99.1332');
    });

    /**
     * Criterio "la fecha y hora incluyen zona horaria definida por el sistema": una hora sin zona
     * no identifica un instante, y este texto queda impreso en un documento que puede leerse en
     * cualquier huso y años después.
     */
    it('la fecha y hora incluyen el desfase de la zona horaria del sistema', () => {
      const fechaLine = service
        .buildContent(signature)
        .split('\n')
        .find((line) => line.startsWith('Fecha y hora:'));

      expect(fechaLine).toMatch(/\d{2}\/\d{2}\/\d{4}/);
      expect(fechaLine).toMatch(/\d{2}:\d{2}:\d{2}/);
      expect(fechaLine).toMatch(/GMT[+-]?\d*/);
    });

    // La constancia en línea que ya existía sigue alcanzable desde el código impreso.
    it('conserva la URL de la constancia de esa firma', () => {
      expect(service.buildContent(signature)).toContain(
        `Constancia: ${VERIFICATION_URL}`,
      );
    });

    // Un renglón vacío o con "undefined" en un documento legal es peor que decir que no se tiene
    // el dato: firmas viejas pueden no traer geolocalización registrada.
    it('marca como no disponibles los datos que la firma no registró', () => {
      const content = service.buildContent({
        signerName: 'SIN DATOS',
        rfc: null,
        ipAddress: null,
        signedAt: null,
        verificationUrl: VERIFICATION_URL,
      });

      expect(content).toContain('RFC: No disponible');
      expect(content).toContain('IP: No disponible');
      expect(content).toContain('Fecha y hora: No disponible');
      expect(content).not.toContain('undefined');
      expect(content).not.toContain('null');
    });
  });

  describe('imagen generada', () => {
    it('devuelve un PNG válido y cuadrado', async () => {
      const buffer = await service.generateAdvancedSignaturePng(signature);

      expect(buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
      const { width, height } = await sharp(buffer).metadata();
      expect(width).toBe(height);
    });

    /**
     * La comprobación que de verdad importa: un escáner apuntado a este código obtiene los datos
     * de la firma. Si el contenido fuera ilegible para un lector común, todo lo demás daría igual.
     */
    it('un escáner lee exactamente los datos de la firma', async () => {
      const png = await service.generateAdvancedSignaturePng(signature);

      await expect(decodeQr(png)).resolves.toBe(
        service.buildContent(signature),
      );
    });

    /**
     * Criterio "los datos corresponden al firmante y a la operación de firma específica": dos
     * firmantes del mismo documento nunca producen la misma imagen.
     */
    it('genera un código distinto por cada firma', async () => {
      const [first, second] = await Promise.all([
        service.generateAdvancedSignaturePng(signature),
        service.generateAdvancedSignaturePng({
          ...signature,
          signerName: 'MARIA GUADALUPE PEREZ LOPEZ',
          rfc: 'PELM850101XYZ',
        }),
      ]);

      expect(first.equals(second)).toBe(false);
    });

    // El QR es una función de los datos de la firma y nada más: sin marcas de tiempo de generación
    // ni aleatoriedad, para que reestampar el mismo documento produzca el mismo código.
    it('es determinista: los mismos datos producen el mismo código', async () => {
      const [first, second] = await Promise.all([
        service.generateAdvancedSignaturePng(signature),
        service.generateAdvancedSignaturePng(signature),
      ]);

      expect(first.equals(second)).toBe(true);
    });
  });
});
