import jsQR from 'jsqr';
import * as sharp from 'sharp';
import { SignatureQrService } from './signature-qr.service';

/**
 * Decodifica el PNG como lo haría un lector de códigos: lo convierte a píxeles crudos RGBA y lo
 * lee con un decodificador real. Es la única forma de comprobar de verdad el criterio "al escanear
 * el QR, se consulta la información asociada a esa firma" — que el código no solo sea un PNG
 * válido, sino que un escáner obtenga de él la URL correcta.
 */
async function decodeQr(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const decoded = jsQR(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
  );
  return decoded?.data ?? null;
}

/** Firma de un PNG: los 8 bytes iniciales que todo archivo PNG válido debe tener. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('SignatureQrService', () => {
  const service = new SignatureQrService();

  const URL_A =
    'https://app.ejemplo.com/public/documents/doc-1/signatures/collab-1';
  const URL_B =
    'https://app.ejemplo.com/public/documents/doc-1/signatures/collab-2';

  it('devuelve un PNG válido', async () => {
    const buffer = await service.generatePngBuffer(URL_A);

    expect(buffer.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(buffer.length).toBeGreaterThan(0);
  });

  /**
   * Criterio de aceptación "se genera un código QR único por cada firma avanzada": el QR codifica
   * la URL de esa firma concreta (documento + colaborador), así que dos firmantes del mismo
   * documento nunca producen la misma imagen.
   */
  it('genera un código distinto por cada firma', async () => {
    const [first, second] = await Promise.all([
      service.generatePngBuffer(URL_A),
      service.generatePngBuffer(URL_B),
    ]);

    expect(first.equals(second)).toBe(false);
  });

  /**
   * La comprobación que de verdad importa: un escáner apuntado a este código obtiene la URL de la
   * constancia de esa firma. Si el QR se generara con la URL equivocada (o ilegible), todo lo
   * demás daría igual — el usuario escanearía y no llegaría a ninguna parte.
   */
  it('un escáner lee exactamente la URL de la firma', async () => {
    const png = await service.generatePngBuffer(URL_A);

    await expect(decodeQr(png)).resolves.toBe(URL_A);
  });

  // La misma firma consultada dos veces tiene que dar el mismo código: el QR es una función de la
  // URL y nada más, sin marcas de tiempo ni aleatoriedad que lo hagan irreproducible.
  it('es determinista: la misma URL produce el mismo código', async () => {
    const [first, second] = await Promise.all([
      service.generatePngBuffer(URL_A),
      service.generatePngBuffer(URL_A),
    ]);

    expect(first.equals(second)).toBe(true);
  });
});
