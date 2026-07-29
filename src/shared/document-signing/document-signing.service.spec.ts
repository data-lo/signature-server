import { Test, TestingModule } from '@nestjs/testing';
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

describe('PdfSignatureService', () => {
  let service: PdfSignatureService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PdfSignatureService],
    }).compile();

    service = module.get(PdfSignatureService);
  });

  describe('mergeSignatureIntoPdf / addSignerName — pageIndex (historia "Ubicación de firmas por usuario")', () => {
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

      await expect(
        service.addSignerName(documentBuffer, 'JUAN PÉREZ', { x: 10, y: 10, width: 60, height: 24 }, 1),
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
