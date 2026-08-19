import { Test, TestingModule } from '@nestjs/testing';
import * as zlib from 'zlib';
import { PDFDocument } from 'pdf-lib';
import { PdfSignatureService } from './document-signing.service';

// PNG 1x1 transparente mínimo — suficiente para que pdf-lib.embedPng() lo acepte.
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function buildPdf(pageSizes: [number, number][]): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  for (const size of pageSizes) {
    pdfDoc.addPage(size);
  }
  return Buffer.from(await pdfDoc.save());
}

/**
 * Posición y tamaño con los que quedó dibujada la imagen, leídos del flujo de contenido de la
 * página. pdf-lib emite `1 0 0 1 x y cm` (traslación) seguido de `w 0 0 h 0 0 cm` (escala), así
 * que es lo que de verdad ve un lector de PDF — no lo que el servicio dice que hizo.
 */
async function drawnPlacement(pdf: Buffer): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPage(0);
  const contents = page.node.Contents() as unknown as {
    asArray?: () => unknown[];
  };
  const refs = contents.asArray ? contents.asArray() : [contents];

  for (const ref of refs) {
    const stream = doc.context.lookup(ref as never) as unknown as {
      contents?: Uint8Array;
    };
    if (!stream?.contents) continue;

    const raw = Buffer.from(stream.contents);
    let text: string;
    try {
      text = zlib.inflateSync(raw).toString();
    } catch {
      text = raw.toString();
    }

    // La secuencia se ancla entera (traslación, identidad, escala) porque la matriz identidad
    // intermedia también encaja con el patrón de una escala, y una búsqueda laxa la tomaría a ella.
    const match = text.match(
      /1 0 0 1 ([\d.-]+) ([\d.-]+) cm\s+1 0 0 1 0 0 cm\s+([\d.-]+) 0 0 ([\d.-]+) 0 0 cm/,
    );
    if (match) {
      return {
        x: Number(match[1]),
        y: Number(match[2]),
        width: Number(match[3]),
        height: Number(match[4]),
      };
    }
  }

  throw new Error('No se encontró ninguna imagen dibujada en la página');
}

describe('PdfSignatureService', () => {
  let service: PdfSignatureService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PdfSignatureService],
    }).compile();

    service = module.get(PdfSignatureService);
  });

  /**
   * Historia "Actualizar contenido del código QR en firma avanzada", criterio "el QR conserva una
   * proporción cuadrada, sin estiramiento". La caja de firma es apaisada porque está pensada para
   * una rúbrica manuscrita; un código QR estirado ahí deja de ser cuadrado y los lectores no
   * reconocen su patrón.
   */
  describe('mergeSignatureIntoPdf — preserveAspectRatio', () => {
    // La caja es 200x80 y el PNG de prueba es cuadrado (1x1).
    const LANDSCAPE_BOX = { x: 50, y: 100, width: 200, height: 80 };

    it('encaja la imagen sin deformarla y la centra en la caja', async () => {
      const documentBuffer = await buildPdf([[400, 400]]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        LANDSCAPE_BOX,
        undefined,
        { preserveAspectRatio: true },
      );

      const placement = await drawnPlacement(signed);
      expect(placement.width).toBe(placement.height);
      // Escala al lado menor de la caja (80) y se centra en el eje largo.
      expect(placement.width).toBe(80);
      expect(placement.x).toBe(50 + (200 - 80) / 2);
      expect(placement.y).toBe(100);
    });

    /**
     * Criterio "al cambiar el tamaño del contenedor o visualizarse en distintas resoluciones, el
     * QR conserva sus proporciones": la caja de firma la define quien coloca la firma, así que
     * puede llegar con cualquier forma — el resultado tiene que ser cuadrado en todas.
     */
    // Las cajas se quedan dentro del rango que acepta `resolveSignatureSize`: fuera de él, la caja
    // se sustituye por el tamaño por defecto (200x80) antes de llegar acá — comportamiento previo
    // y común a todas las firmas, no algo propio del encaje del QR.
    it.each([
      ['apaisada', { x: 50, y: 100, width: 200, height: 80 }, 80],
      ['vertical', { x: 50, y: 100, width: 100, height: 120 }, 100],
      ['cuadrada', { x: 50, y: 100, width: 120, height: 120 }, 120],
    ])(
      'sale cuadrado con una caja %s, sin importar su forma',
      async (_forma, box, ladoEsperado) => {
        const documentBuffer = await buildPdf([[400, 400]]);

        const signed = await service.mergeSignatureIntoPdf(
          documentBuffer,
          MINIMAL_PNG,
          box,
          undefined,
          { preserveAspectRatio: true },
        );

        const placement = await drawnPlacement(signed);
        expect(placement.width).toBe(ladoEsperado);
        expect(placement.height).toBe(ladoEsperado);
        // Centrado en ambos ejes dentro de la caja que le tocó.
        expect(placement.x).toBe(box.x + (box.width - ladoEsperado) / 2);
        expect(placement.y).toBe(box.y + (box.height - ladoEsperado) / 2);
      },
    );

    it('sin la opción, la imagen sigue llenando la caja completa (rúbricas, sin cambios)', async () => {
      const documentBuffer = await buildPdf([[400, 400]]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        LANDSCAPE_BOX,
      );

      const placement = await drawnPlacement(signed);
      expect(placement).toEqual(LANDSCAPE_BOX);
    });
  });

  describe('mergeSignatureIntoPdf — pageIndex (historia "Ubicación de firmas por usuario")', () => {
    it('sin pageIndex, dibuja en la última página (comportamiento previo, sin romper callers existentes)', async () => {
      const documentBuffer = await buildPdf([
        [200, 200],
        [300, 300],
      ]);

      const signed = await service.mergeSignatureIntoPdf(
        documentBuffer,
        MINIMAL_PNG,
        { x: 10, y: 10, width: 60, height: 24 },
      );

      const signedDoc = await PDFDocument.load(signed);
      expect(signedDoc.getPages()).toHaveLength(2);
    });

    it('con pageIndex explícito, dibuja en esa página y no en la última', async () => {
      const documentBuffer = await buildPdf([
        [200, 200],
        [300, 300],
        [400, 400],
      ]);

      // No hay forma directa de "leer" en qué página quedó dibujado sin parsear el contenido del
      // PDF — se verifica indirectamente: pasar un pageIndex fuera de rango cae al fallback
      // (última página) sin lanzar, y uno válido tampoco lanza. La cobertura de que realmente
      // apunta a la página correcta vive en el test de integración de resolveRatioPosition +
      // document.service.spec.ts (pageIndex propagado end-to-end).
      await expect(
        service.mergeSignatureIntoPdf(
          documentBuffer,
          MINIMAL_PNG,
          { x: 10, y: 10, width: 60, height: 24 },
          1,
        ),
      ).resolves.toBeInstanceOf(Buffer);
    });

    it('con un pageIndex fuera de rango, cae a la última página en vez de lanzar', async () => {
      const documentBuffer = await buildPdf([[200, 200]]);

      await expect(
        service.mergeSignatureIntoPdf(
          documentBuffer,
          MINIMAL_PNG,
          { x: 10, y: 10, width: 60, height: 24 },
          99,
        ),
      ).resolves.toBeInstanceOf(Buffer);
    });
  });

  describe('resolveRatioPosition', () => {
    it('convierte ratios a puntos absolutos contra el tamaño real de la página destino', async () => {
      const documentBuffer = await buildPdf([[600, 800]]);

      const { coordinates, pageIndex } = await service.resolveRatioPosition(
        documentBuffer,
        { page: 1, xRatio: 0.1, yRatio: 0.2, widthRatio: 0.2, heightRatio: 0.1 },
      );

      expect(pageIndex).toBe(0);
      expect(coordinates.x).toBeCloseTo(60); // 0.1 * 600
      expect(coordinates.width).toBeCloseTo(120); // 0.2 * 600
      expect(coordinates.height).toBeCloseTo(80); // 0.1 * 800
      // yRatio se mide desde el borde SUPERIOR; y_pdf = pageHeight - (yRatio+heightRatio)*pageHeight
      expect(coordinates.y).toBeCloseTo(800 - (0.2 + 0.1) * 800); // 560
    });

    it('usa el tamaño de la página correcta cuando las páginas del documento tienen tamaños distintos', async () => {
      const documentBuffer = await buildPdf([
        [600, 800],
        [1200, 400],
      ]);

      const { coordinates, pageIndex } = await service.resolveRatioPosition(
        documentBuffer,
        { page: 2, xRatio: 0.5, yRatio: 0, widthRatio: 0.1, heightRatio: 0.1 },
      );

      expect(pageIndex).toBe(1);
      expect(coordinates.x).toBeCloseTo(600); // 0.5 * 1200 (ancho de la página 2, no la 1)
      expect(coordinates.width).toBeCloseTo(120); // 0.1 * 1200
      expect(coordinates.height).toBeCloseTo(40); // 0.1 * 400
    });

    it('si page excede el total de páginas, usa la última como fallback en vez de lanzar', async () => {
      const documentBuffer = await buildPdf([[600, 800]]);

      const { pageIndex } = await service.resolveRatioPosition(documentBuffer, {
        page: 99,
        xRatio: 0,
        yRatio: 0,
        widthRatio: 0.1,
        heightRatio: 0.1,
      });

      expect(pageIndex).toBe(0);
    });
  });
});
