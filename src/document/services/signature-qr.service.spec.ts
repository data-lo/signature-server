import jsQR from 'jsqr';
import * as sharp from 'sharp';
import {
  SignatureQrService,
  type AdvancedSignatureQrData,
} from './signature-qr.service';

/**
 * Decodifica el PNG como lo haría un lector de códigos: lo convierte a píxeles crudos RGBA y lo
 * lee con un decodificador real. Es la única forma de comprobar de verdad el criterio "al escanear
 * el QR se abre la vista pública del documento" — que el código no sólo sea un PNG válido, sino
 * que un escáner obtenga de él exactamente esa URL y nada más.
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
 * URL con la forma que produce `buildAdvancedSignatureUrl`: la vista pública del DOCUMENTO, con
 * la firma señalada por query. La construcción en sí se prueba en
 * `document-access-url.util.spec.ts`; acá sólo hace falta una URL realista.
 */
const VERIFICATION_URL =
  'http://localhost:3001/public/documents/doc-1?firma=collab-1';

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
    verificationUrl: VERIFICATION_URL,
  };

  describe('contenido del código', () => {
    /**
     * Historia "Redirigir QR de firma avanzada a la vista pública y resaltar al firmante": el
     * contenido es la URL a secas. Un QR cuyo contenido es exactamente una URL lo reconocen como
     * enlace la cámara nativa y el lector del teléfono; en cuanto se le antepone una línea de
     * texto pasa a ser un QR de texto y deja de ser accionable.
     */
    it('es exactamente la URL de la vista pública, sin envoltura', () => {
      expect(service.buildContent(signature)).toBe(VERIFICATION_URL);
    });

    /**
     * Se afirma la AUSENCIA de cada dato porque volver a agregarlos es un renglón, y este texto
     * queda impreso dentro de un PDF que nadie revisa después. El QR viaja en documentos que se
     * imprimen y se reenvían: lo que se codifique ahí queda legible para cualquiera que lo
     * escanee, sin pasar por el control de qué publica la vista pública.
     */
    it.each([
      ['el nombre del firmante', 'JUAN ANGEL CEPEDA FERNANDEZ'],
      ['el RFC', 'CEFJ800101ABC'],
      ['la IP', '189.237.82.225'],
    ])('no publica %s', (_caso, valor) => {
      const content = service.buildContent({
        verificationUrl: VERIFICATION_URL,
      });

      expect(content).not.toContain(valor);
    });

    /** Ni etiquetas ni renglones: cualquier cosa fuera de la URL rompe el reconocimiento. */
    it('no lleva etiquetas ni saltos de línea', () => {
      const content = service.buildContent(signature);

      expect(content.split('\n')).toHaveLength(1);
      expect(content).not.toMatch(/Firmante:|RFC:|IP:|Constancia:/);
    });

    /** La geolocalización tampoco vuelve por la puerta de atrás. */
    it('no publica la geolocalización', () => {
      const content = service.buildContent(signature);

      expect(content).not.toMatch(/geolocaliza/i);
      expect(content).not.toContain('19.4326');
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
     * La comprobación que de verdad importa: un escáner apuntado a este código obtiene la URL de
     * la vista pública. Si el contenido fuera ilegible para un lector común, todo lo demás daría
     * igual.
     */
    it('un escáner lee exactamente la URL de la vista pública', async () => {
      const png = await service.generateAdvancedSignaturePng(signature);

      await expect(decodeQr(png)).resolves.toBe(VERIFICATION_URL);
    });

    /**
     * Criterio "la URL incluye un parámetro para identificar la firma específica": dos firmantes
     * del mismo documento apuntan a la misma vista pública pero señalan firmas distintas, así que
     * sus códigos no pueden coincidir.
     */
    it('genera un código distinto por cada firma del mismo documento', async () => {
      const [first, second] = await Promise.all([
        service.generateAdvancedSignaturePng(signature),
        service.generateAdvancedSignaturePng({
          verificationUrl:
            'http://localhost:3001/public/documents/doc-1?firma=collab-2',
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
